import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, fetchCandles, fetchLivePrices, chunk, asArray, round } from "../../shared/market.ts";
import { analyzeCoin } from "../../shared/strategy.ts";
import { scanBoard } from "../../shared/scan.ts";
import { QUOTE_ASSET, placeMarketOrder, resolveLiveConnection } from "../../shared/orders.ts";
import { readAccount, fetchListedSymbols, fetchMarketConstraints, accountValueUsd, pickFundingQuote, isBackedOff, backoffUntil, balanceJustRead } from "../../shared/exchanges.ts";
import { loadLessons, recordLesson } from "../../shared/learn.ts";
import { collectGateLocks, raiseGateLockAlerts } from "../../shared/rulelock.ts";
import { entryMinimum, entryRulesFor, gateReason as gateReasonShared, liveEntrySize } from "../../shared/entryRules.ts";
import { loadSmartBias } from "../../shared/smartmoney.ts";
import { syncExchangePositions } from "../../shared/reconcile.ts";

const DEFAULT_CONFIG = {
  mode: "approve",
  starting_balance: 10000,
  cash_balance: 10000,
  risk_per_trade_pct: 4,
  max_open_positions: 8,
  default_stop_pct: 2.5,
  target_pct: 2,
  daily_target_pct: 2,
  trailing_stop: true,
  trailing_trigger_pct: 3,
  trailing_distance_pct: 1.5,
  allow_shorts: true,
  timeframe: "1h",
  market_cap_scope: "all",
  min_score: 62,
  require_daily_target: true,
  cooldown_minutes: 120,
  auto_run: true,
  real_orders_enabled: false,
  real_connection_id: "",
  real_sizing_mode: "paper",
  fixed_order_usd: 100,
  live_cap_usd: 0,
  trading_style: "mild",
  profit_mode: "compound",
  max_trade_loss_pct: 20,
  combo_engine: true,
  margin_engine: false,
  sentiment_watch: true,
  confluence_v2: true,
  champion_engine: true,
  active_desk: "paper",
};

// An aggressive-style trade that has gone nowhere for a quarter of the scan
// timeframe is cut so the capital moves on to fresher setups.
const TIMEFRAME_MS = {
  "15m": 15 * 60000,
  "1h": 60 * 60000,
  "4h": 4 * 60 * 60000,
  "12h": 12 * 3600000,
  "1d": 24 * 60 * 60000,
  "1w": 7 * 24 * 60 * 60000,
  "1M": 30 * 24 * 60 * 60000,
};

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const light = body.light === true;
    const dryRun = body.dry_run === true;

    // one set of rules only: keep the freshest config and remove stray older
    // ones, so every cycle and screen agrees on a single balance
    const configs = asArray(
      await base44.entities.BotConfig.filter({}, { sort: "-updated_date", limit: 10 }),
    );
    if (!dryRun) for (const extra of configs.slice(1)) await base44.entities.BotConfig.delete(extra.id);
    let config = configs[0];
    if (!config && dryRun) return Response.json({ error: "Save bot rules before checking entries" }, { status: 400 });
    if (!config) config = await base44.entities.BotConfig.create(DEFAULT_CONFIG);

    // Live and paper desks keep separate rules: the paper rules stay on the
    // config itself, the live rules sit in live_rules and fall back to the
    // paper value when a live rule was never set. Everything the live leg
    // decides — sizing, slots, score bar, trailing, cooldown, budget —
    // reads these, never the paper rules.
    const LR = config.live_rules || {};
    const lrVal = (key, fb) => (LR[key] != null ? LR[key] : config[key] != null ? config[key] : fb);
    const liveConfigView = { ...config, real_connection_id: lrVal("real_connection_id", "") || "" };

    // single-flight: a cycle that started moments ago is still scanning, and
    // two overlapping cycles read the same empty state and opened the same
    // position twice. A fresh start timestamp makes later cycles stagger.
    const startedAt = config.last_cycle_started_at
      ? Date.parse(config.last_cycle_started_at)
      : 0;
    // only full cycles scan and trade, so only they share the single-flight
    // guard: a cheap light cycle must never block the desk's fresh scan
    const full = !dryRun && !light;
    const cycleInFlight = full && startedAt > 0 && Date.now() - startedAt < 45000;
    // claim the cycle slot, then verify the claim stuck: two cycles starting
    // in the same instant both read the old timestamp and both passed the
    // window above — the read-back catches the loser, which manages exits
    // only and skips the scan, so it can never open duplicate positions
    let claimConfirmed = false;
    if (full) {
      const claim = new Date().toISOString();
      await base44.entities.BotConfig.update(config.id, { last_cycle_started_at: claim });
      const fresh = asArray(
        await base44.entities.BotConfig.filter({}, { sort: "-updated_date", limit: 1 }),
      )[0];
      claimConfirmed = !fresh || fresh.last_cycle_started_at === claim;
    }

    // light cycles only manage open positions — their prices come from the
    // batched live feed, so the whole-market fetch (and its cap-feed probes,
    // which took tens of seconds whenever a provider was down) is skipped
    // entirely: the desk load waits on this call, so it must stay fast
    const { coins } = light ? { coins: [] } : await fetchMarkets(base44.asServiceRole);
    const priceMap = new Map(coins.map((c) => [c.symbol, c]));

    // Existing exit management is preserved. Entry quality is governed by
    // the shared managed policy, not the old optimizer/target vetoes.
    const engineV2 = config.engine_v2 !== false;
    const champion = config.champion_engine !== false;
    // COMBO ENGINE (round 25-28 champion): the optimizer's tested stack governs
    // entries when on - score bar 70, ADX 28, volume band 2x-4x, stochastic
    // agreement, RSI chase block, conviction candles, BTC risk-off longs - and
    // sets 4.5R targets with break-even at +1.2R instead of trailing stops.
    const comboOn = config.combo_engine !== false;
    // MARGIN ENGINE (optimizer rounds 29-36): the combo stack re-targeted to
    // 3R, conviction loosened to 50%, restricted to the tested majors + AVAX
    // universe. Off by default — leverage moves losses as fast as gains.
    const marginOn = config.margin_engine === true;
    // margin shorts open at this leverage level on Kraken; gains and losses
    // both scale with it
    const marginLeverage = Math.max(1, Math.min(5, Number(config.margin_leverage) || 2));

    // entity reads cap each page, so a plain read silently missed open trades
    // once the desk held more than a page — the exact window that let already
    // open symbols be traded again. Page through until every match is in.
    async function readAll(query, sort = "-created_date") {
      const out = [];
      let cursor;
      do {
        const page = await base44.entities.Trade.filter(query, {
          sort,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        out.push(...asArray(page));
        cursor = page && page.next_cursor;
      } while (cursor);
      return out;
    }

    // one query for every open trade: the paper desk manages its own records
    // from this list and the live block filters out the real ones, instead of
    // paying for a second identical read that only doubled entity traffic
    // the open-trade read and the live-connection resolution are independent —
    // one parallel round instead of two serial waits
    const [openTrades, managedRes] = await Promise.all([
      readAll({ status: "open" }),
      resolveLiveConnection(base44, liveConfigView, { manage: true, readOnly: dryRun }),
    ]);

    // live prices for every symbol with an open position: one batched public
    // call keeps exits (stop/target/trailing) on the real tape instead of the
    // up-to-a-minute-old market snapshot, without per-symbol API calls
    const livePrices = await fetchLivePrices(openTrades.map((t) => t.symbol));
    for (const [sym, px] of livePrices) {
      const coin = priceMap.get(sym);
      if (coin && px > 0) coin.price = px;
      // wallet-imported positions can sit on coins the US feed does not list:
      // give them a live-priced row so the bot still manages them
      if (!coin && px > 0)
        priceMap.set(sym, { symbol: sym, name: sym, coingecko_id: "", image: "", price: px, market_cap: 0, volume24h: 0, change24h: 0, rank: 0 });
    }
    // managing existing real positions must work even while new live entries
    // are paused — the pause gates entries, never risk management
    const managed = managedRes;
    const live = config.real_orders_enabled === true
      ? managed
      : { conn: null, reason: "Live trading is paused", info: managed.info };
    // a check can flag a key (temporary lockout, a revoked permission) without
    // the key being unusable — management still attempts real orders through
    // it, but new live entries keep requiring a verified, trading-enabled
    // connection, so flagged keys never fire fresh buys
    const liveVerified =
      !!managed.info && managed.info.status === "connected" && managed.info.allow_trading === true;
    // real orders settle in the exchange's native quote currency (USD on
    // Kraken), so fiat held in another currency — however it converts for
    // display — can never fund an order. Real sizing reads the native quote
    // balance, not the converted figure, so a CAD-only Kraken account stops
    // firing orders the exchange refuses with EOrder:Insufficient funds.
    const connRow = managed.conn
      ? await base44.asServiceRole.entities.ExchangeConnection
          .get(managed.conn.id)
          .catch(() => null)
      : null;
    // the funding asset is what orders actually settle in: USD, or USDT
    // after a CAD (or EUR/GBP) balance was swapped on the USDT/fiat market
    const funding = connRow ? pickFundingQuote(connRow.balances, connRow.exchange) : null;
    const spendableQuote = funding ? funding.amount : 0;
    let quoteLeft = spendableQuote;
    if (managed.conn && funding) managed.conn.quoteAsset = funding.asset;
    // live budget: how much exchange money the bot may put to work in total,
    // minus what its open real positions already hold — once the budget is
    // gone, qualifying setups stay paper instead of breaching the cap
    const liveBudgetCap = Number(lrVal("live_cap_usd", 0)) || 0;
    let liveBudget = liveBudgetCap > 0
      ? liveBudgetCap -
        openTrades
          .filter((t) => (t.mode || "paper") === "real")
          .reduce((a, t) => a + (Number(t.size_usd) || 0), 0)
      : Infinity;
    let cash = Number(config.cash_balance) || 0;
    const closed = [];
    const positions = [];
    const pendingMarks = [];
    const sentinel = [];

    /**
     * Shared close path for bot-managed positions: sends the real sell order
     * when the position is a bot-placed real one, books the result, alerts
     * and remembers the lesson. Returns false when the exchange refused.
     */
    async function closeOut(t, side, exitPrice, reason, extraUpdates = {}, alertFor) {
      if (t.mode === "real" && t.exchange_order_id) {
        if (!managed.conn) {
          // never book a close the exchange has not confirmed: with live
          // trading paused or the connection unhealthy, the real position
          // stays open and one alert is raised instead of a silent paper close
          const recent = asArray(
            await base44.entities.Alert.filter(
              {
                trade_id: t.id,
                kind: "order_failed",
                created_date: { $gte: new Date(Date.now() - 30 * 60000).toISOString() },
              },
              { limit: 1 },
            ),
          );
          if (!recent.length)
            await base44.entities.Alert.create({
              symbol: t.symbol,
              title: `Cannot close ${t.symbol} right now`,
              message: managed.reason || "The exchange connection is unavailable — the position stays open.",
              mode: "live",
              kind: "order_failed",
              severity: "danger",
              trade_id: t.id,
            });
          if (Object.keys(extraUpdates).length)
            await base44.entities.Trade.update(t.id, extraUpdates);
          return false;
        }
        // a locked key needs silence to clear: signed orders placed into a
        // lockout count against it and extend the lock, so the close waits
        // out the backoff instead of hammering the exchange each cycle
        if (isBackedOff(connRow)) {
          const lockAlert = asArray(
            await base44.entities.Alert.filter(
              {
                trade_id: t.id,
                kind: "order_failed",
                created_date: { $gte: new Date(Date.now() - 30 * 60000).toISOString() },
              },
              { limit: 1 },
            ),
          );
          if (!lockAlert.length)
            await base44.entities.Alert.create({
              symbol: t.symbol,
              title: `${t.symbol} close waits out the exchange lockout`,
              message: "The exchange key is temporarily locked after failed attempts — the position stays open and closes once the lock clears.",
              mode: "live",
              kind: "order_failed",
              severity: "warning",
              trade_id: t.id,
            });
          if (Object.keys(extraUpdates).length)
            await base44.entities.Trade.update(t.id, extraUpdates);
          return false;
        }
        // a margin short closes by buying the base quantity back, not selling
        const sell = await placeMarketOrder(managed.conn, {
          symbol: t.symbol,
          side: side === "short" ? "buy" : "sell",
          quantity: Number(t.quantity) || 0,
        });
        // dust: the exchange can never sell this little — book the close on
        // the desk without an order instead of stranding the position
        if (!sell.ok && !sell.dust) {
          await base44.entities.Alert.create({
            symbol: t.symbol,
            title: `Could not close ${t.symbol} on ${managed.conn.label}`,
            message: sell.message,
            mode: "live",
            kind: "order_failed",
            severity: "danger",
            trade_id: t.id,
          });
          if (Object.keys(extraUpdates).length)
            await base44.entities.Trade.update(t.id, extraUpdates);
          return false;
        }
        if (sell.avg_price) exitPrice = sell.avg_price;
      }
      const entry = Number(t.entry_price) || 0;
      const qty = Number(t.quantity) || 0;
      const size = Number(t.size_usd) || 0;
      const pnl = side === "long" ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
      const pnlPct = size ? (pnl / size) * 100 : 0;
      await base44.entities.Trade.update(t.id, {
        ...extraUpdates,
        status: "closed",
        exit_price: round(exitPrice, 8),
        pnl_usd: round(pnl),
        pnl_pct: round(pnlPct),
        closed_at: new Date().toISOString(),
        exit_reason: reason,
      });
      if ((t.mode || "paper") === "paper")
        cash += (config.profit_mode || "compound") === "stack" ? Math.min(pnl, 0) : size + pnl;
      closed.push({
        id: t.id,
        symbol: t.symbol,
        side,
        exit_price: round(exitPrice, 8),
        pnl_usd: round(pnl),
        pnl_pct: round(pnlPct),
        exit_reason: reason,
      });
      const meta = alertFor ? alertFor(pnl, pnlPct) : {};
      const dustNote = sell && sell.dust
        ? `The exchange holds ${sell.held_qty} ${t.symbol}, below its minimum sellable amount — closed on the desk without an order. `
        : "";
      await base44.entities.Alert.create({
        symbol: t.symbol,
        title: `${t.symbol} closed ${pnl >= 0 ? "in profit" : "at a loss"} (${round(pnlPct)}%)`,
        message: dustNote + (meta.message || ""),
        mode: (t.mode || "paper") === "real" ? "live" : "paper",
        kind: meta.kind || "bot_close",
        severity: dustNote ? "warning" : pnl >= 0 ? "success" : "danger",
        trade_id: t.id,
      });
      // remember the call: its pattern now carries this result into future scans
      await recordLesson(base44, t, pnlPct, pnl, reason);
      return true;
    }

    /**
     * 3R scale-out (the pooled flat-tape winner, three 6-month windows):
     * half the position books at +3R, the runner's stop moves to break-even,
     * and the rest runs to the target. The booked leg becomes its own closed
     * trade record, so journal totals and pooled reviews match the backtest's
     * leg accounting. Returns false to keep the position whole this cycle.
     */
    async function scaleOut(t, side, scalePrice, newStop) {
      const entry = Number(t.entry_price) || 0;
      const qty = Number(t.quantity) || 0;
      const size = Number(t.size_usd) || 0;
      const halfQty = qty / 2;
      if (!(entry > 0) || !(halfQty > 0)) return false;
      if (t.mode === "real" && t.exchange_order_id) {
        if (!managed.conn || isBackedOff(connRow)) return false;
        // half the order under the exchange minimum: stay whole and let the
        // full position close at its target instead of spamming refused orders
        if (!(size / 2 >= 10)) return false;
        const sell = await placeMarketOrder(managed.conn, {
          symbol: t.symbol,
          side: side === "short" ? "buy" : "sell",
          quantity: halfQty,
        });
        if (!sell.ok) return false;
        if (sell.avg_price) scalePrice = sell.avg_price;
      }
      const legQty = round(halfQty, 8);
      const legSize = round(size / 2);
      const pnl = side === "long" ? (scalePrice - entry) * legQty : (entry - scalePrice) * legQty;
      const pnlPct = legSize ? (pnl / legSize) * 100 : 0;
      await base44.entities.Trade.create({
        symbol: t.symbol,
        name: t.name,
        image: t.image,
        side,
        mode: t.mode || "paper",
        status: "closed",
        entry_price: round(entry, 8),
        exit_price: round(scalePrice, 8),
        quantity: legQty,
        size_usd: legSize,
        stop_price: t.stop_price,
        target_price: t.target_price,
        target_r: t.target_r,
        score: t.score,
        pattern: t.pattern,
        exchange: t.exchange,
        pnl_usd: round(pnl),
        pnl_pct: round(pnlPct),
        exit_reason: "scale",
        opened_at: t.opened_at,
        closed_at: new Date().toISOString(),
        signal_id: t.signal_id,
        rationale: "Scale-out: half booked at +3R, the runner's stop sits at break-even",
      });
      if ((t.mode || "paper") === "paper")
        cash += (config.profit_mode || "compound") === "stack" ? Math.min(pnl, 0) : legSize + pnl;
      await base44.entities.Trade.update(t.id, {
        quantity: legQty,
        size_usd: legSize,
        scaled: true,
        stop_price: round(newStop, 8),
      });
      await base44.entities.Alert.create({
        symbol: t.symbol,
        title: `${t.symbol} scaled out at +3R`,
        message: `Half the position booked at ${round(scalePrice, 8)} — P&L ${round(pnl)} USD. The runner's stop sits at break-even and keeps its target.`,
        mode: (t.mode || "paper") === "real" ? "live" : "paper",
        kind: "target_hit",
        severity: "success",
        trade_id: t.id,
      });
      await recordLesson(base44, { ...t, quantity: legQty, size_usd: legSize }, pnlPct, pnl, "scale");
      return true;
    }

    // ---- manage the positions already open
    for (const t of dryRun ? [] : openTrades) {
      // a real fill the user logged by hand is theirs to manage — the bot only
      // touches its own real positions (those carry an exchange order id)
      if ((t.mode || "paper") === "real" && !t.exchange_order_id) continue;
      const price = priceMap.get(t.symbol)?.price ?? null;
      if (!price) continue;
      const side = t.side === "short" ? "short" : "long";
      const entry = Number(t.entry_price) || 0;
      if (!entry) continue;

      const gainPct =
        side === "long" ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;
      let stop = Number(t.stop_price) || (side === "long" ? entry * 0.975 : entry * 1.025);
      const target = Number(t.target_price) || 0;
      const prevPeak = Number(t.peak_price) || entry;
      let peak = prevPeak;
      const updates = {};

      // engine_v2: break-even once the trade is +1.2R in — the optimizer
      // winner's protective stop move, applied before any trailing
      const targetR = Number(t.target_r) || 0;
      if (engineV2 && targetR && target) {
        const bePct = ((Math.abs(target - entry) / targetR) / entry) * 100 * 1.2;
        if (gainPct >= bePct) {
          const be = side === "long" ? entry * 1.0005 : entry * 0.9995;
          if (side === "long" ? be > stop : be < stop) stop = be;
        }
      }

      // trailing follows the desk the position trades on: real positions
      // trail by the live rules, paper ones by the paper rules
      const isRealPos = (t.mode || "paper") === "real";
      // trailing follows the desk the position trades on: real positions
      // trail by the live rules whenever the user left trailing on there —
      // the combo engine's break-even and 4.5R target exits still run as
      // tested, and the trailing stop ratchets on top once its trigger hits.
      // The paper desk keeps the tested stacks' behavior (no trailing on
      // combo/margin targets)
      const trailingOn = isRealPos
        ? lrVal("trailing_stop", true) !== false
        : (Number(t.target_r) || 0) >= 3
          ? false
          : config.trailing_stop !== false;
      if (trailingOn) {
        if (side === "long" && price > peak) peak = price;
        if (side === "short" && price < peak) peak = price;
        if (gainPct >= Number(isRealPos ? lrVal("trailing_trigger_pct", 3) : (config.trailing_trigger_pct ?? 3))) {
          const dist =
            Number(isRealPos ? lrVal("trailing_distance_pct", 1.5) : (config.trailing_distance_pct ?? 1.5)) / 100;
          const trail = side === "long" ? peak * (1 - dist) : peak * (1 + dist);
          if (side === "long" && trail > stop) stop = trail;
          if (side === "short" && trail < stop) stop = trail;
        }
        if (peak !== prevPeak) updates.peak_price = round(peak, 8);
      }
      if (stop !== Number(t.stop_price)) updates.stop_price = round(stop, 8);

      const hitTarget = target
        ? side === "long"
          ? price >= target
          : price <= target
        : false;
      const hitStop = side === "long" ? price <= stop : price >= stop;
      // aggressive style: a trade that has sat going nowhere for STAGNANT_HOURS
      // is cut so the capital moves on to fresher setups
      const openedMs = t.opened_at ? Date.parse(t.opened_at) : 0;
      const stagnant =
        (config.trading_style || "mild") === "aggressive" &&
        openedMs > 0 &&
        Date.now() - openedMs > (TIMEFRAME_MS[config.timeframe || "1h"] || TIMEFRAME_MS["1h"]) / 4 &&
        // time must never close a position just because it is winning or
        // flat: only underwater stalls are cut here, the trailing stop and
        // the target own the profitable side of time
        gainPct < 0;
      // per-trade max loss guard: a trade down more than max_trade_loss_pct
      // of its own deployed size is force-closed at market — the backstop
      // when a stop sits too wide or the tape moved past the desk's checks
      const maxLossPct = isRealPos
        ? Number(lrVal("max_trade_loss_pct", 20)) || 0
        : Number(config.max_trade_loss_pct) || 0;
      const hitMaxLoss = maxLossPct > 0 && gainPct <= -maxLossPct;
      // 3R scale-out: fires once, at +3R, on the stacks tested at scale-out
      // targets (6R combo). A 3R margin target coincides with its own target
      // and closes whole; break-even already protects the runner at +1.2R.
      const rUnitPct = targetR && target ? (Math.abs(target - entry) / targetR / entry) * 100 : 0;
      if (
        !hitTarget && !hitStop && !hitMaxLoss && !stagnant &&
        targetR >= 4 && rUnitPct && !t.scaled &&
        gainPct >= rUnitPct * 3
      ) {
        const be = side === "long" ? entry * 1.0005 : entry * 0.9995;
        const newStop = side === "long" ? Math.max(stop, be) : Math.min(stop, be);
        if (await scaleOut(t, side, price, newStop)) continue;
      }
      const exit = hitTarget || hitStop || stagnant || hitMaxLoss;

      if (exit) {
        // the stop always wins: a breached stop fills at its level — the same
        // fill the backtest assumes — even when the tape gapped past it, and
        // never at the market price of a later stagnant cut. A bar that touched
        // both levels fills the stop first, the backtest's own conservative
        // rule, so a "target" exit can never book a loss.
        const exitPrice = hitStop ? stop : hitTarget ? target : price;
        const reason = hitStop
          ? updates.stop_price
            ? "trailing"
            : "stop"
          : stagnant
            ? "time"
            : hitMaxLoss
              ? "max_loss"
              : "target";
        const ok = await closeOut(t, side, exitPrice, reason, updates, (pnl, pnlPct) => ({
          kind: reason === "time" ? "bot_close" : reason === "target" ? "target_hit" : "stop_hit",
          message: `${
            reason === "target"
              ? "Target reached"
              : reason === "trailing"
                ? "Trailing stop hit"
                : reason === "max_loss"
                  ? "Max loss guard: the trade reached its per-trade loss cap"
                  : reason === "time"
                    ? "Stagnant trade cut after sitting still too long"
                    : "Stop hit"
          } at ${round(exitPrice, 8)}. P&L ${round(pnl)} USD.`,
        }));
        if (!ok) continue;
      } else {
        // a surviving position the sentiment pass below re-reads
        sentinel.push(t);
        // mark-to-market writes are batched after the loop: one bulk write
        // instead of one per position keeps us under the entity rate limit
        if (Object.keys(updates).length) pendingMarks.push({ id: t.id, ...updates });
        const qty = Number(t.quantity) || 0;
        const size = Number(t.size_usd) || 0;
        const unreal = side === "long" ? (price - entry) * qty : (entry - price) * qty;
        const travelled = side === "long" ? price - entry : entry - price;
        const goal = target ? Math.abs(target - entry) : 0;
        positions.push({
          id: t.id,
          symbol: t.symbol,
          name: t.name,
          image: t.image,
          side,
          mode: t.mode || "paper",
          entry_price: entry,
          current_price: round(price, 8),
          stop_price: round(stop, 8),
          target_price: target,
          size_usd: size,
          pnl_usd: round(unreal),
          pnl_pct: size ? round((unreal / size) * 100) : 0,
          progress_pct: goal ? round(Math.max(0, Math.min(100, (travelled / goal) * 100))) : 0,
        });
      }
    }

    if (pendingMarks.length)
      await base44.entities.Trade.bulkUpdate(pendingMarks.slice(0, 500));

    // signals age out: a setup older than a day is no longer actionable
    if (!light && !dryRun) {
      await base44.asServiceRole.entities.Signal
        .updateMany(
          {
            status: "new",
            detected_at: { $lt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
          },
          { $set: { status: "expired" } },
        )
        .catch(() => {});
    }

    // ---- sentiment watch: re-read every surviving position's chart so a
    // market turn is caught between stops. When the same engine that picked
    // the trade now favors the other side with conviction, the position is
    // closed (reason "flipped") and the capital is free for the next scan.
    const sentimentReads = new Map();
    if (!light && config.sentiment_watch !== false && sentinel.length) {
      const moves = coins
        .map((c) => c.change24h)
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);
      const medianChange24h = moves.length ? moves[Math.floor(moves.length / 2)] : 0;
      const tf = config.timeframe || "1h";
      for (const group of chunk([...new Set(sentinel.map((t) => t.symbol))], 6)) {
        const settled = await Promise.allSettled(
          group.map((s) => fetchCandles(s, tf, 300)),
        );
        settled.forEach((res, i) => {
          if (res.status !== "fulfilled" || !res.value) return;
          const coin = priceMap.get(group[i]);
          if (!coin) return;
          const row = analyzeCoin(coin, res.value, {
            medianChange24h,
            dailyTargetPct: Number(config.daily_target_pct) || 2,
            barsPerDay:
              { "15m": 96, "1h": 24, "4h": 6, "12h": 2, "1d": 1, "1w": 1 / 7, "1M": 1 / 30 }[tf] || 24,
            confluenceV2: config.confluence_v2 !== false,
          });
          if (row) sentimentReads.set(group[i], row);
        });
      }
    }
    for (const t of sentinel) {
      const row = sentimentReads.get(t.symbol);
      if (!row) continue;
      const side = t.side === "short" ? "short" : "long";
      const flipped =
        side === "long"
          ? row.side === "short" && row.score >= 65
          : row.side === "long" && row.score >= 65;
      // thesis decay: an underwater trade whose fresh read barely still
      // supports its own side is closed instead of drifting down to the stop
      const ownScore = side === "long" ? row.long_score : row.short_score;
      const livePrice = Number(priceMap.get(t.symbol)?.price) || 0;
      const entryPrice = Number(t.entry_price) || 0;
      const weakened =
        entryPrice && livePrice
          ? (side === "long" ? livePrice < entryPrice : livePrice > entryPrice) &&
            ownScore != null &&
            ownScore < 45
          : false;
      if (!flipped && !weakened) continue;
      const flipPrice = Number(row.price) || livePrice || 0;
      if (!flipPrice) continue;
      const reason = flipped ? "flipped" : "weakened";
      const trailing = pendingMarks.find((m) => m.id === t.id);
      const ok = await closeOut(t, side, flipPrice, reason, trailing || {}, (pnl, pnlPct) => ({
        kind: "bot_close",
        message: flipped
          ? `Sentiment flipped on the ${config.timeframe || "1h"} chart: the read now favors ${row.side} (score ${row.score}). Closed at ${round(flipPrice, 8)}. P&L ${round(pnl)} USD.`
          : `Thesis weakened on the ${config.timeframe || "1h"} chart: the ${side} read fell to ${ownScore} while the trade is underwater. Closed at ${round(flipPrice, 8)}. P&L ${round(pnl)} USD.`,
      }));
      if (ok) {
        const idx = pendingMarks.findIndex((m) => m.id === t.id);
        if (idx >= 0) pendingMarks.splice(idx, 1);
      }
    }

    // ---- look for new entries. The two desks qualify setups by their own
    // rules: the live leg scores against the live rules and fires real
    // orders, the paper leg trades the paper rules with paper cash. The
    // scan itself stays shared — one board, two rule sets read from it.
    const closedIds = new Set(closed.map((c) => c.id));
    const stillOpen = openTrades.filter((t) => !closedIds.has(t.id));
    const liveOpenCount = stillOpen.filter((t) => (t.mode || "paper") === "real").length;
    const paperOpenCount = stillOpen.filter((t) => (t.mode || "paper") === "paper").length;
    const openCount = stillOpen.length;
    const paperMaxOpen = Math.max(1, Number(config.max_open_positions) || 8);
    const liveMaxOpen = Math.max(1, Number(lrVal("max_open_positions", 8)) || 8);
    const opened = [];
    const proposed = [];
    let eligibleCount = null;
    const deskDiag = {};
    let board = { rows: [], scannedCount: 0, universeCount: coins.length, summary: null, medianChange24h: 0, source: "cache" };
    let scanLog = null;

    const scanGateOpen =
      paperOpenCount < paperMaxOpen ||
      (live.conn != null && liveVerified && liveOpenCount < liveMaxOpen);

    if (!light && config.mode !== "off" && scanGateOpen && !cycleInFlight && (dryRun || claimConfirmed)) {
      const watch = asArray(await base44.entities.Watchlist.list({ limit: 60 }));
      // when real orders are on, only scan coins the connected exchange
      // actually lists — anything else could never be bought there
      // scan only markets the account's funding currency can actually settle
      const listed = live.conn ? await fetchListedSymbols(live.conn, funding ? [funding.asset] : null) : null;
      if (listed) eligibleCount = listed.size;
      // a symbol whose order just failed is left alone for an hour: every
      // refused signed order still counts toward the exchange's temporary
      // lockout, so re-firing into the same refusal each cycle never happens
      const failedRecently = asArray(
        await base44.entities.Alert.filter(
          {
            created_by_id: config.created_by_id,
            kind: "order_failed",
            mode: "live",
            created_date: { $gte: new Date(Date.now() - 60 * 60000).toISOString() },
          },
          { limit: 50 },
        ),
      ).map((a) => a.symbol);
      board = await scanBoard({
        timeframe: config.timeframe || "1h",
        scope: config.market_cap_scope || "all",
        count: 60,
        dailyTargetPct: Number(config.daily_target_pct) || 2,
        extraSymbols: watch.map((w) => w.symbol),
        ...(listed ? { onlySymbols: listed } : {}),
        confluenceV2: config.confluence_v2 !== false,
      });

      // cooldowns are per desk: each desk leaves its own closed trades alone
      // for its own cooldown, both with the 30-minute churn floor that keeps
      // a trade the stagnant rule just cut from being re-entered at once
      const reentryMs = 30 * 60000;
      const paperCooldownMs = (Number(config.cooldown_minutes) || 120) * 60000;
      const liveCooldownMs = (Number(lrVal("cooldown_minutes", 120)) || 120) * 60000;
      const since = new Date(Date.now() - Math.max(paperCooldownMs, liveCooldownMs, reentryMs)).toISOString();
      const recent = await readAll({ closed_at: { $gte: since } });
      // proposals block their symbol while pending — but only fresh ones:
      // proposals left over from an approve-mode era (never acted on) blocked
      // their symbols forever and silently killed re-entries on both desks
      const pending = (await readAll({ status: "proposed" })).filter(
        (t) => (t.created_date || "") >= new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      );
      const blockedLive = new Set([
        ...stillOpen.filter((t) => (t.mode || "paper") === "real").map((t) => t.symbol),
        ...recent
          .filter((t) => {
            if ((t.mode || "paper") !== "real") return false;
            const closedMs = t.closed_at ? Date.parse(t.closed_at) : 0;
            const window = t.exit_reason === "time" ? reentryMs : liveCooldownMs;
            return Date.now() - closedMs < window;
          })
          .map((t) => t.symbol),
        ...pending.map((t) => t.symbol),
        ...failedRecently,
      ]);
      const blockedPaper = new Set([
        ...stillOpen.filter((t) => (t.mode || "paper") === "paper").map((t) => t.symbol),
        ...recent
          .filter((t) => {
            if ((t.mode || "paper") === "real") return false;
            const closedMs = t.closed_at ? Date.parse(t.closed_at) : 0;
            const window = t.exit_reason === "time" ? reentryMs : paperCooldownMs;
            return Date.now() - closedMs < window;
          })
          .map((t) => t.symbol),
        ...pending.map((t) => t.symbol),
      ]);

      // trading style bends the rules without touching what the user saved:
      // timid waits for stronger setups with less at stake, aggressive
      // accepts more setups and stakes more to reach the goal faster
      const style = config.trading_style || "mild";
      const styleRisk = style === "timid" ? 0.75 : style === "aggressive" ? 1.4 : 1;
      // BTC's 24h tape drives the combo regime gate (risk-off longs, flat-tape skips)
      const btcChange = (coins.find((c) => c.symbol === "BTC") || {}).change24h ?? null;
      const rulesByDesk = {
        live: entryRulesFor(config, "live", btcChange),
        paper: entryRulesFor(config, "paper", btcChange),
      };
      const entryGate = (r, desk) => gateReasonShared(r, desk, rulesByDesk[desk]);
      const liveSlots = Math.max(1, liveMaxOpen - liveOpenCount);
      const riskPct = Math.min(25, (Number(config.risk_per_trade_pct) || 4) * styleRisk);

      // self-teaching: past results per pattern (side x cap tier) nudge scores
      const lessons = await loadLessons(base44);
      const lessonMap = new Map(lessons.map((l) => [l.pattern, l]));

      // smart money: where the top on-chain traders are positioned nudges
      // scores the same way — aligned with their flow, capped at +-5 points
      const smartBias = await loadSmartBias(base44);

      const tradable = board.rows.map((r) => {
        const adj = lessonMap.get(`${r.side}/${r.market_cap_bucket}`)?.adj || 0;
        let smartAdj = 0;
        let smartNote = null;
        const smart = smartBias.get(r.symbol);
        if (smart) {
          const total = (smart.long_usd || 0) + (smart.short_usd || 0);
          if (total > 0) {
            const longShare = (smart.long_usd || 0) / total;
            smartAdj = Math.max(-5, Math.min(5, Math.round((longShare - 0.5) * 20)));
            if (r.side !== "long") smartAdj = -smartAdj;
            if (Math.abs(smartAdj) >= 2) {
              const sharePct = Math.round(Math.max(longShare, 1 - longShare) * 100);
              const dir = longShare >= 0.5 ? "long" : "short";
              smartNote = `Smart money net ${dir}: ${sharePct}% of top-trader open size`;
            }
          }
        }
        const scoreAdj = adj + smartAdj;
        const reasons = smartNote && (r.reasons || []).length ? [...r.reasons, smartNote] : r.reasons;
        return scoreAdj || smartNote ? { ...r, score: r.score + scoreAdj, reasons } : r;
      });

      // engine targets: 6R from entry with the combo stack on (the pooled
      // flat-tape winner), 2.5R under the old engine rules - always on the
      // trade's own side, so the distance is |entry - stop| measured outward
      const targetR = marginOn ? 3 : comboOn ? 6 : 2.5;
      const engineTarget = (r) => {
        const dist = targetR * Math.abs(r.entry - r.stop);
        return round(r.side === "long" ? r.entry + dist : r.entry - dist, 8);
      };
      const useEngineTarget = marginOn || comboOn || (engineV2 && champion);
      const qualifies = (r, desk) => {
        const blocked = desk === "live" ? blockedLive : blockedPaper;
        return !blocked.has(r.symbol) && entryGate(r, desk) === null;
      };
      const liveWanted = live.conn && liveVerified && !isBackedOff(connRow)
        ? tradable
            .filter((r) => qualifies(r, "live"))
            .slice(0, Math.max(0, liveMaxOpen - liveOpenCount))
        : [];
      // a desk with qualifying setups but nothing to pay with should say so
      // once (throttled), instead of firing order attempts into a wall of
      // exchange-side insufficient-funds failures every cycle
      if (!dryRun && live.conn && liveWanted.length && spendableQuote < 10) {
        const recent = asArray(
          await base44.entities.Alert.filter(
            {
              created_by_id: config.created_by_id,
              kind: "order_failed",
              mode: "live",
              created_date: { $gte: new Date(Date.now() - 30 * 60000).toISOString() },
            },
            { limit: 1 },
          ),
        );
        if (!recent.length)
          await base44.entities.Alert.create({
            symbol: liveWanted[0].symbol,
            title: `No spendable quote currency on ${live.conn.label}`,
            message: `${liveWanted.length} qualifying setup(s) skipped — the account holds no funds in a currency its orders settle in. Deposit the native quote currency, or use the convert button on the connection card, to enable live buys.`,
            mode: "live",
            kind: "order_failed",
            severity: "danger",
          });
      }
      const gateReason = entryGate;
      const constraints = live.conn ? await fetchMarketConstraints(live.conn) : null;
      // trade from the live tape: refresh the wanted symbols' prices so real
      // order sizing and target placement use the current price, not the
      // snapshot the scan ran on
      const livePx = await fetchLivePrices([...new Set(liveWanted.map((r) => r.symbol))]);
      const atLive = (r) => {
        const px = Number(livePx.get(r.symbol)) || 0;
        return px > 0 ? { ...r, entry: px } : r;
      };
      const minimumFor = (r) => entryMinimum(constraints, r.symbol, funding?.asset || QUOTE_ASSET[live.conn?.exchange] || "USDT", r.entry);
      const liveRiskPct = Math.min(25, (Number(lrVal("risk_per_trade_pct", 4)) || 4) * styleRisk);
      const sizeLive = (r, slots) => liveEntrySize({ row: r, balance: quoteLeft, budget: liveBudget, slots,
        riskPct: liveRiskPct, minimum: minimumFor(r) });
      // claim only what the live desk can actually pay for: size each wanted
      // setup the way the entry loop will, so setups live cannot afford fall
      // through to the paper desk instead of being claimed and dropped. The
      // old pre-claim starved the paper desk of every qualifying setup the
      // moment live trading was ready but the budget was small.
      const livePlans = [];
      if (live.conn && liveVerified && !isBackedOff(connRow) && liveBudget >= 10 && spendableQuote >= 10) {
        let simBudget = liveBudget;
        let simQuote = quoteLeft;
        for (const r of liveWanted) {
          if (stillOpen.some((t) => t.symbol === r.symbol)) continue;
          const size = liveEntrySize({
            row: r,
            balance: simQuote,
            budget: simBudget,
            slots: Math.max(1, liveSlots - livePlans.length),
            riskPct: liveRiskPct,
            minimum: minimumFor(r),
          });
          if (!(size >= 10)) continue;
          livePlans.push({ r, size: round(size, 2) });
          simBudget -= size;
          simQuote -= size * 1.005;
        }
      }
      // the live desk claims only setups it has an affordable plan for;
      // everything else stays in the paper pool
      const liveSymbols = new Set(livePlans.map((p) => p.r.symbol));
      const paperWanted = tradable
        .filter((r) => !liveSymbols.has(r.symbol) && qualifies(r, "paper"))
        .slice(0, Math.max(0, paperMaxOpen - paperOpenCount));
      if (dryRun) {
        const plans = [];
        for (const r of liveWanted) {
          if (stillOpen.some(t => t.symbol === r.symbol)) continue;
          const rl = atLive(r);
          const size = sizeLive(rl, Math.max(1, liveSlots - plans.length));
          if (!size) continue;
          plans.push({ symbol: r.symbol, side: r.side, score: r.score, size_usd: size,
            entry: rl.entry, stop: r.stop, target: engineV2 && champion ? engineTarget(rl) : r.target });
          quoteLeft -= size * 1.005;
          liveBudget -= size;
        }
        return Response.json({ dry_run: true, mode: config.mode, scanned: board.scannedCount,
          live: {         entry_ready: live.conn != null && liveVerified && !isBackedOff(connRow), reason: live.reason,
            spendable_quote: spendableQuote, budget_cap: liveBudgetCap, planned: plans },
          paper: { qualifying: paperWanted.filter(r => !stillOpen.some(t => t.symbol === r.symbol))
            .map(r => ({ symbol: r.symbol, side: r.side, score: r.score })) },
          rule_lock: collectGateLocks(tradable, gateReason, { desks: ["live", "paper"],
            slots: { live: liveMaxOpen - liveOpenCount, paper: paperMaxOpen - paperOpenCount },
            blocked: { live: blockedLive, paper: blockedPaper },
            taken: { live: plans.length, paper: paperWanted.length } }) });
      }
      const takenSymbols = new Set([...liveWanted, ...paperWanted].map((r) => r.symbol));
      scanLog = {
        scanned: board.scannedCount,
        blocked: 0,
        below_score: tradable.filter((r) => !takenSymbols.has(r.symbol)).length,
        taken: takenSymbols.size,
      };

      for (const { r, desk } of [
        ...liveWanted.map((row) => ({ r: row, desk: "live" })),
        ...paperWanted.map((row) => ({ r: row, desk: "paper" })),
      ]) {
        // final guard: even if a paged read missed it, never open a second
        // position in a symbol that already has one open
        const alreadyOpen = await base44.entities.Trade.count({
          status: "open",
          symbol: r.symbol,
        });
        if (alreadyOpen) continue;
        const stopDist = Math.abs(r.entry - r.stop);
        if (!(stopDist > 0)) continue;

        // paper sizing — also what "match paper" live sizing spends
        const freeSlots = Math.max(
          1,
          paperMaxOpen - paperOpenCount - opened.filter((o) => o.mode === "paper").length - proposed.length,
        );
        const cap = cash / freeSlots;
        const riskUsd = (cash * riskPct) / 100;
        let qty = riskUsd / stopDist;
        let sizeUsd = qty * r.entry;
        if (sizeUsd > cap) {
          sizeUsd = cap;
          qty = sizeUsd / r.entry;
        }

        // live leg: a market buy on the exchange, sized by the live risk
        // rules — risk per trade % of the spendable exchange balance, risked
        // between entry and stop (the same maths as the paper desk), within
        // the live budget. A refused order is alerted and a live-qualified
        // setup never falls back to paper silently.
        let real = null;
        let realSizeUsd = 0;
        // the live leg spends its pre-sized plan; a setup without an
        // affordable plan was never claimed, so paper inherits it below
        const plan = desk === "live" ? livePlans.find((p) => p.r.symbol === r.symbol) : null;
        const rl = plan ? plan.r : atLive(r);
        if (plan && live.conn && liveBudget >= 10 && spendableQuote >= 10) {
          realSizeUsd = plan.size;
          const isShort = r.side === "short";
          real = await placeMarketOrder(live.conn, {
            symbol: r.symbol,
            side: isShort ? "sell" : "buy",
            usd: realSizeUsd,
            price: rl.entry,
            // a live short is a Kraken margin order: the account sells an
            // asset it holds none of, backed by the margin account
            ...(isShort ? { margin: true, leverage: marginLeverage } : {}),
          });
          if (!real.ok) {
            await base44.entities.Alert.create({
              symbol: r.symbol,
              title: `Real order failed on ${r.symbol}`,
              message: real.message,
              mode: "live",
              kind: "order_failed",
              severity: "danger",
            });
            continue;
          }
          liveBudget -= realSizeUsd;
          quoteLeft -= realSizeUsd * 1.005;
        }

        if (real) {
          const created = await base44.entities.Trade.create({
            symbol: r.symbol,
            name: r.name,
            image: r.image,
            side: r.side,
            mode: "real",
            status: config.mode === "auto" ? "open" : "proposed",
            entry_price: round(real.avg_price || rl.entry, 8),
            quantity: round(real.filled_qty || realSizeUsd / r.entry, 8),
            size_usd: round(realSizeUsd),
            stop_price: r.stop,
            target_price: useEngineTarget ? engineTarget(rl) : r.target,
            target_r: marginOn ? 3 : comboOn ? 6 : engineV2 && champion ? 2.5 : null,
            peak_price: real.avg_price || rl.entry,
            score: r.score,
            pattern: `${r.side}/${r.market_cap_bucket}`,
            exchange: live.conn.exchange,
            exchange_order_id: real.order_id,
            rationale: (r.reasons || []).join(" • "),
            opened_at: new Date().toISOString(),
          });
          if (config.mode === "auto") {
            opened.push({
              id: created.id,
              symbol: r.symbol,
              side: r.side,
              entry: r.entry,
              size_usd: round(realSizeUsd),
              mode: "real",
            });
            await base44.entities.Alert.create({
              symbol: r.symbol,
              title: `Bot opened a ${r.side} on ${r.symbol}`,
              message: `Entry ${r.entry}, target ${r.target} (${r.required_move_pct}% move), stop ${r.stop}. Score ${r.score}. Real order placed on ${live.conn.label}.`,
              mode: "live",
              kind: "bot_open",
              severity: "info",
              trade_id: created.id,
            });
          } else {
            proposed.push({
              id: created.id,
              symbol: r.symbol,
              side: r.side,
              entry: r.entry,
              target: r.target,
              stop: r.stop,
              score: r.score,
              size_usd: round(realSizeUsd),
            });
          }
          continue;
        }

        // paper leg: booked against the paper cash balance only
        if (desk !== "paper" || sizeUsd < 10) continue;
        const created = await base44.entities.Trade.create({
          symbol: r.symbol,
          name: r.name,
          image: r.image,
          side: r.side,
          mode: "paper",
          status: config.mode === "auto" ? "open" : "proposed",
          entry_price: round(r.entry, 8),
          quantity: round(qty, 8),
          size_usd: round(sizeUsd),
          stop_price: r.stop,
          target_price: useEngineTarget ? engineTarget(r) : r.target,
          target_r: comboOn ? 6 : engineV2 ? 2.5 : null,
          peak_price: r.entry,
          score: r.score,
          pattern: `${r.side}/${r.market_cap_bucket}`,
          rationale: (r.reasons || []).join(" • "),
          opened_at: new Date().toISOString(),
        });
        if (config.mode === "auto") {
          cash -= sizeUsd;
          opened.push({
            id: created.id,
            symbol: r.symbol,
            side: r.side,
            entry: r.entry,
            size_usd: round(sizeUsd),
            mode: "paper",
          });
          await base44.entities.Alert.create({
            symbol: r.symbol,
            title: `Bot opened a ${r.side} on ${r.symbol}`,
            message: `Entry ${r.entry}, target ${r.target} (${r.required_move_pct}% move), stop ${r.stop}. Score ${r.score}.`,
            mode: "paper",
            kind: "bot_open",
            severity: "info",
            trade_id: created.id,
          });
        } else {
          proposed.push({
            id: created.id,
            symbol: r.symbol,
            side: r.side,
            entry: r.entry,
            target: r.target,
            stop: r.stop,
            score: r.score,
            size_usd: round(sizeUsd),
          });
        }
      }

      Object.assign(
        deskDiag,
        collectGateLocks(tradable, gateReason, {
          desks: live.conn ? ["live", "paper"] : ["paper"],
          slots: { live: liveMaxOpen - liveOpenCount, paper: paperMaxOpen - paperOpenCount },
          blocked: { live: blockedLive, paper: blockedPaper },
          taken: { live: liveSymbols.size, paper: paperWanted.length },
        }),
      );
    }

    if (dryRun) return Response.json({ dry_run: true, mode: config.mode, scanned: 0,
      live: {         entry_ready: live.conn != null && liveVerified && !isBackedOff(connRow), reason: live.reason, planned: [] },
      paper: { qualifying: [] }, reason: config.mode === "off" ? "Signals only" : "No open position slots" });

    // rule-lock alerts: one warning per desk per 6 hours when the desk's own
    // rules rejected every candidate the scan produced
    if (!light) await raiseGateLockAlerts(base44, deskDiag, config.created_by_id);

    // ---- daily goal check. "Today" follows the user's clock, not UTC: the
    // old UTC-midnight boundary bucketed an evening trader's results into
    // the next day, so the counter disagreed with the journal (even flipping
    // sign). The desk sends getTimezoneOffset() (minutes west of UTC);
    // callers that don't send it keep the UTC day.
    const tzOffset = Number.isFinite(body.tz_offset) ? Number(body.tz_offset) : 0;
    const localNowMs = Date.now() - tzOffset * 60000;
    const dayStartMs = Math.floor(localNowMs / 86400000) * 86400000 + tzOffset * 60000;
    const dayStart = new Date(dayStartMs);
    const todayKey = new Date().toISOString().slice(0, 10);
    // everything the desk stats need — the day's closes, the running totals,
    // and the four equity-candle reads — in one parallel round instead of
    // eight serial waits; this chain was seconds of every cycle
    const [todays, realizedAgg, deployedAgg, prevCandlesPage, existingCandlePage, prevLivePage, existingLivePage] =
      await Promise.all([
        readAll({ status: "closed", closed_at: { $gte: dayStart.toISOString() } }),
        base44.entities.Trade.aggregate({ query: { status: "closed", mode: "paper" }, sum: "pnl_usd" }),
        base44.entities.Trade.aggregate({ query: { status: "open", mode: "paper" }, sum: "size_usd" }),
        base44.entities.EquityCandle.filter({ owner: user.id, day: { $lt: todayKey } }, { sort: "-day", limit: 1 }),
        base44.entities.EquityCandle.filter({ owner: user.id, day: todayKey }, { limit: 1 }),
        base44.entities.EquityCandle.filter({ owner: `${user.id}|live`, day: { $lt: todayKey } }, { sort: "-day", limit: 1 }),
        base44.entities.EquityCandle.filter({ owner: `${user.id}|live`, day: todayKey }, { limit: 1 }),
      ]);
    const prevCandles = asArray(prevCandlesPage);
    const existingCandle = asArray(existingCandlePage)[0];
    const prevLiveCandles = asArray(prevLivePage);
    const existingLive = asArray(existingLivePage)[0];
    // the headline counter and the daily goal track the paper bot's results —
    // real trades already report through the live stats block
    const paperTodays = todays.filter((t) => (t.mode || "paper") === "paper");
    const realizedToday = paperTodays.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);
    const startBalance = Number(config.starting_balance) || 10000;
    const goal = (startBalance * (Number(config.daily_target_pct) || 2)) / 100;
    let goalHit = false;
    if (goal > 0 && realizedToday >= goal) {
      goalHit = true;
      const existing = asArray(
        await base44.entities.Alert.filter(
          { kind: "daily_goal", created_date: { $gte: dayStart.toISOString() } },
          { limit: 5 },
        ),
      );
      if (!existing.length) {
        await base44.entities.Alert.create({
          title: `Daily target reached: +${round((realizedToday / startBalance) * 100)}%`,
          message: `Closed profit today is ${round(realizedToday)} USD against a ${round(goal)} USD target.`,
          mode: "paper",
          kind: "daily_goal",
          severity: "success",
        });
      }
    }

    // ---- live (exchange) stats: every real trade, bot-placed or hand-logged
    const livePositions = openTrades
      .filter((t) => (t.mode || "paper") === "real")
      .map((t) => {
      const side = t.side === "short" ? "short" : "long";
      const entry = Number(t.entry_price) || 0;
      const price = priceMap.get(t.symbol)?.price ?? entry;
      const qty = Number(t.quantity) || 0;
      const size = Number(t.size_usd) || 0;
      const unreal = entry && price ? (side === "long" ? (price - entry) * qty : (entry - price) * qty) : 0;
      const goal = Number(t.target_price) ? Math.abs(Number(t.target_price) - entry) : 0;
      const travelled = side === "long" ? price - entry : entry - price;
      return {
        id: t.id,
        symbol: t.symbol,
        name: t.name,
        image: t.image,
        side,
        mode: "real",
        exchange: t.exchange || null,
        pair: `${t.symbol}/${(funding && funding.asset) || QUOTE_ASSET[t.exchange] || "USDT"}`,
        entry_price: entry,
        current_price: round(price, 8),
        stop_price: t.stop_price,
        target_price: t.target_price,
        size_usd: round(size),
        pnl_usd: round(unreal),
        pnl_pct: size ? round((unreal / size) * 100) : 0,
        progress_pct: goal ? round(Math.max(0, Math.min(100, (travelled / goal) * 100))) : 0,
      };
    });
    const liveExposure = livePositions.reduce((a, p) => a + p.size_usd, 0);
    const liveUnrealized = livePositions.reduce((a, p) => a + p.pnl_usd, 0);
    // already fetched with the paper day's closes above: same status and same
    // time window, only the mode differs — no second read needed
    const liveRealized = todays
      .filter((t) => (t.mode || "paper") === "real")
      .reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);

    // the exchange's own quote-currency balance, refreshed on full cycles only
    let exchangeBalance = null;
    let freshBalances = null;
    let balanceAsOf = null;
    let balanceStale = false;
    let balanceError = null;
    if (managed.conn && !light && isBackedOff(managed.conn)) {
      // the key failed a signed read recently — do not touch it: every failed
      // attempt keeps the exchange-side lockout alive. The saved balance and
      // the stale flag carry the desk through until the backoff expires.
      balanceStale = true;
      balanceError = `Retrying ${managed.conn.label} after the last failed read — paused until ${managed.conn.backoff_until}`;
      if (managed.conn.balance_usd != null) {
        exchangeBalance = round(Number(managed.conn.balance_usd) || 0, 2);
        balanceAsOf = managed.conn.balance_updated_at || null;
      }
    } else if (managed.conn && !light && !balanceJustRead(managed.conn)) {
      const acct = await readAccount({
        exchange: managed.conn.exchange,
        testnet: managed.conn.testnet,
        api_key: managed.conn.api_key,
        api_secret: managed.conn.api_secret,
        passphrase: managed.conn.passphrase || "",
      });
      if (acct.ok) {
        freshBalances = acct.balances;
        // total account value (every holding priced) — the funding cash the
        // bot sizes with is read separately from the balances list
        exchangeBalance = await accountValueUsd(managed.conn, acct.balances);
        // keep the balance on the connection so a later failed read never
        // leaves the desk blank
        await base44.asServiceRole.entities.ExchangeConnection.update(managed.conn.id, {
          balance_usd: exchangeBalance,
          balance_updated_at: new Date().toISOString(),
          balances: (acct.balances || []).slice(0, 10),
        });
        balanceAsOf = new Date().toISOString();
      } else {
        // never treat a failed read as current: the desk shows the failure
        balanceStale = true;
        balanceError = acct.message;
        // and every background reader backs the key off, so a failed read is
        // never retried straight into an exchange-side lockout
        await base44.asServiceRole.entities.ExchangeConnection.update(managed.conn.id, {
          backoff_until: backoffUntil(acct.message),
        });
        // but the last saved balance still beats a blank figure
        if (managed.conn.balance_usd != null) {
          exchangeBalance = round(Number(managed.conn.balance_usd) || 0, 2);
          balanceAsOf = managed.conn.balance_updated_at || null;
        }
      }
    }

    // ---- wallet sync: reconcile the desk's open real positions with what
    // the exchange actually holds. Untracked holdings are imported as
    // positions the bot then manages, positions sold off on the exchange are
    // closed on the desk, partial differences are reconciled. This runs on
    // every full cycle (throttled to one sync per 10 minutes) so the desk and
    // the wallet stay reconciled permanently.
    let walletSync = null;
    if (
      managed.conn &&
      !light &&
      !dryRun &&
      !isBackedOff(connRow) &&
      Date.now() - (Number(config.last_wallet_sync_at) || 0) > 10 * 60000
    ) {
      const syncBalances = freshBalances || (connRow && Array.isArray(connRow.balances) ? connRow.balances : null);
      if (syncBalances && syncBalances.length) {
        walletSync = await syncExchangePositions(
          base44,
          // the fill-history throttle reads the last pull time off the stored row
          { ...managed.conn, fills_fetched_at: connRow ? connRow.fills_fetched_at : null },
          syncBalances,
          {
          ownerId: config.created_by_id,
          stopPct: Number(lrVal("default_stop_pct", 2.5)),
          targetR: marginOn ? 3 : comboOn ? 6 : engineV2 && champion ? 2.5 : 0,
        });
        await base44.entities.BotConfig.update(config.id, { last_wallet_sync_at: Date.now() });
      }
    }

    // ---- live desk extras: the day's goal (the live target pct of the
    // exchange balance, saved balance when the live read failed) plus the
    // best and worst closed real trades of the day, so the desk can render
    // its progress and day movers without a second read
    const liveDayPct = Number(config.live_rules?.daily_target_pct ?? config.daily_target_pct) || 2;
    const liveGoalBase =
      exchangeBalance != null
        ? exchangeBalance
        : managed.info?.balance_usd != null
          ? Number(managed.info.balance_usd)
          : null;
    const liveGoal = liveGoalBase != null ? round((liveGoalBase * liveDayPct) / 100) : null;
    const liveDayTrades = todays
      .filter((t) => (t.mode || "paper") === "real")
      .map((t) => ({
        symbol: t.symbol,
        side: t.side === "short" ? "short" : "long",
        pnl_usd: round(Number(t.pnl_usd) || 0),
        pnl_pct: round(Number(t.pnl_pct) || 0),
        exit_reason: t.exit_reason || null,
        exchange: t.exchange || null,
        closed_at: t.closed_at || null,
      }))
      .sort((a, b) => b.pnl_usd - a.pnl_usd);

    const exposure = positions.reduce((a, p) => a + p.size_usd, 0);
    const unrealized = positions.reduce((a, p) => a + p.pnl_usd, 0);

    // anchor the paper cash to the trades themselves: the original balance
    // plus everything booked minus what is deployed. Trusting the running
    // cash figure alone let it drift (overlapping cycles, balance resets
    // with positions open) and the desk quietly traded on money it didn't
    // have; anchored, equity always ties to booked profit exactly.
    // totals were fetched in the parallel stats read above
    const realizedTotal = realizedAgg?.rows?.[0]?.sum_pnl_usd ?? 0;
    const deployedTotal = deployedAgg?.rows?.[0]?.sum_size_usd ?? 0;
    // profit handling: compound rolls booked profit back into the trading
    // pool; stack sets profits aside so only the starting capital (plus any
    // accumulated losses) is at risk
    const stacked = Math.max(realizedTotal, 0);
    const anchoredCash =
      (config.profit_mode || "compound") === "stack"
        ? startBalance + (realizedTotal - stacked) - deployedTotal
        : startBalance + realizedTotal - deployedTotal;
    // equity ties directly to the money: starting balance plus everything
    // booked plus what the open positions are worth now. Mixing the in-loop
    // exposure with the aggregate understated equity whenever a position had
    // no live price (its size was subtracted but never added back).
    // NOTE (kept-sane guard): these equity/cash figures feed the desk panels
    // (EquityPanel.jsx, TodayProgress.jsx). The on-screen percent divides net
    // P&L by the first candle's open or the starting balance — NEVER by a
    // `|| 1` fallback, which once showed a bogus ±469% whenever a balance was
    // missing. After touching anything here, check both desk panels still
    // show sane percentages (paper and live) before shipping.
    const equity = startBalance + realizedTotal + unrealized;

    await base44.entities.BotConfig.update(config.id, {
      cash_balance: round(anchoredCash),
      last_run_at: new Date().toISOString(),
    });

    // ---- save today's equity candle so the chart keeps its history even as
    // old trades age out of the journal
    const paperRealizedToday = realizedToday;
    // candles are per-user: one app user's equity chart must not overwrite
    // another's, so every write carries the owner and keys on owner + day
    const prevClose = prevCandles.length ? Number(prevCandles[0].close) : null;
    const candleOpen = existingCandle
      ? Number(existingCandle.open)
      : prevClose != null
        ? prevClose
        : round(startBalance + realizedTotal - paperRealizedToday);
    const highBase = existingCandle ? Number(existingCandle.high) || candleOpen : candleOpen;
    const lowBase = existingCandle ? Number(existingCandle.low) || candleOpen : candleOpen;
    await base44.entities.EquityCandle.upsert(
      [
        {
          owner: user.id,
          day: todayKey,
          open: round(candleOpen),
          high: round(Math.max(highBase, candleOpen, equity)),
          low: round(Math.min(lowBase, candleOpen, equity)),
          close: round(equity),
          realized: round(paperRealizedToday),
          trades: paperTodays.length,
        },
      ],
      { key: ["owner", "day"] },
    );

    // ---- live desk equity candles: the same day-by-day history for real
    // trading, stored under a live-suffixed owner so the paper candles — and
    // the paper desk reset — stay untouched. Skipped when the exchange
    // balance could not be read this cycle, so stale figures never become
    // candle history.
    const liveEquityNow = exchangeBalance != null ? round(exchangeBalance + liveUnrealized) : null;
    if (liveEquityNow != null) {
      const liveOwner = `${user.id}|live`;
      const liveTodays = todays.filter((t) => (t.mode || "paper") === "real");
      const prevLiveClose = prevLiveCandles.length ? Number(prevLiveCandles[0].close) : null;
      const liveOpen = existingLive
        ? Number(existingLive.open)
        : prevLiveClose != null
          ? prevLiveClose
          : liveEquityNow;
      const liveHighBase = existingLive ? Number(existingLive.high) || liveOpen : liveOpen;
      const liveLowBase = existingLive ? Number(existingLive.low) || liveOpen : liveOpen;
      await base44.entities.EquityCandle.upsert(
        [
          {
            owner: liveOwner,
            day: todayKey,
            open: round(liveOpen),
            high: round(Math.max(liveHighBase, liveOpen, liveEquityNow)),
            low: round(Math.min(liveLowBase, liveOpen, liveEquityNow)),
            close: round(liveEquityNow),
            realized: round(liveRealized),
            trades: liveTodays.length,
          },
        ],
        { key: ["owner", "day"] },
      );
    }

    return Response.json({
      mode: config.mode,
      closed,
      opened,
      proposed,
      positions,
      // the desk's top picks display the target the bot actually trades:
      // 6R from entry with the combo stack on, not the scan's raw level
      top: (board.rows || []).slice(0, 12).map((r) => {
        const dist = (marginOn ? 3 : 6) * Math.abs(r.entry - r.stop);
        const target =
          (marginOn || comboOn) && r.entry > 0 && r.stop > 0 && r.entry !== r.stop
            ? round(r.side === "long" ? r.entry + dist : r.entry - dist, 8)
            : r.target;
        return {
          ...r,
          target,
          pair: `${r.symbol}/${(managed.conn && (managed.conn.quoteAsset || QUOTE_ASSET[managed.conn.exchange])) || "USDT"}`,
          exchange: managed.conn ? managed.conn.exchange : null,
        };
      }),
      scanned: board.scannedCount,
      scan_log: scanLog,
      rule_lock: deskDiag,
      universe: board.universeCount,
      summary: board.summary,
      median_change_24h: board.medianChange24h,
      source: board.source,
      cash: round(anchoredCash),
      profit_mode: config.profit_mode || "compound",
      stacked: round(stacked),
      exposure: round(exposure),
      unrealized: round(unrealized),
      equity: round(equity),
      realized_today: round(realizedToday),
      daily_goal: round(goal),
      goal_hit: goalHit,
      live: {
        enabled: config.real_orders_enabled === true,
        paused: config.real_orders_enabled !== true,
        entry_ready: config.real_orders_enabled === true && live.conn != null && liveVerified,
        connection: managed.info
          ? {
              label: managed.info.label,
              exchange: managed.info.exchange,
              status: managed.info.status,
              status_message: managed.info.status_message,
              allow_trading: managed.info.allow_trading,
              last_checked_at: managed.info.last_checked_at,
              balance_usd: managed.info.balance_usd,
              balance_updated_at: managed.info.balance_updated_at,
            }
          : null,
        eligible_markets: eligibleCount,
        balance_usd: exchangeBalance,
        balance_as_of: balanceAsOf,
        balance_stale: balanceStale,
        balance_error: balanceError,
        open_count: livePositions.length,
        cap_usd: liveBudgetCap,
        budget_left: liveBudgetCap > 0 ? round(Math.max(0, liveBudgetCap - liveExposure)) : null,
        exposure: round(liveExposure),
        unrealized: round(liveUnrealized),
        realized_today: round(liveRealized),
        daily_goal: liveGoal,
        goal_hit: liveGoal != null ? liveRealized >= liveGoal : false,
        day_best: liveDayTrades[0] || null,
        day_worst: liveDayTrades.length > 1 ? liveDayTrades[liveDayTrades.length - 1] : null,
        positions: livePositions,
      },
      sentiment: {
        checked: sentimentReads.size,
        flips: closed.filter((c) => c.exit_reason === "flipped").length,
        weakened: closed.filter((c) => c.exit_reason === "weakened").length,
      },
      wallet_sync: walletSync
        ? { imported: walletSync.imported.length, closed: walletSync.closed.length, adjusted: walletSync.adjusted.length, reason: walletSync.reason }
        : null,
      open_count: positions.length,
      config,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}