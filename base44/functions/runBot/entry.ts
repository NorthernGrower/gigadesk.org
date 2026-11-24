import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, fetchCandles, fetchLivePrices, chunk, asArray, round } from "../../shared/market.ts";
import { analyzeCoin } from "../../shared/strategy.ts";
import { scanBoard, resolveDeskVenue } from "../../shared/scan.ts";
import { QUOTE_ASSET, placeMarketOrder, resolveLiveConnection } from "../../shared/orders.ts";
import { readAccount, fetchListedSymbols, fetchMarketConstraints, accountValueUsd, pickFundingQuote, isBackedOff, backoffUntil, balanceJustRead, SHORT_VENUES } from "../../shared/exchanges.ts";
import { loadLessons, recordLesson } from "../../shared/learn.ts";
import { collectGateLocks, raiseGateLockAlerts } from "../../shared/rulelock.ts";
import { entryMinimum, entryRulesFor, gateReason as gateReasonShared, liveEntrySize } from "../../shared/entryRules.ts";
import { loadSmartBias } from "../../shared/smartmoney.ts";
import { liveRule, liveRulesView } from "../../shared/deskRules.ts";
import { syncExchangePositions } from "../../shared/reconcile.ts";
import { btcTrendUp, evaluateV3, v3ExitDue, v3Plan } from "../../shared/v3algo.ts";
import { capPositionSize, losingStreak, riskState } from "../../shared/risk.ts";
import { pickTopPicks } from "../../shared/topPicks.ts";

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
  pyramid: false,
  pyramid_trigger_pct: 1.5,
  combo_engine: true,
  margin_engine: false,
  sentiment_watch: true,
  confluence_v2: true,
  champion_engine: true,
  active_desk: "paper",
  v3_algo: false,
  v3_profile: "loose",
  always_take_top: false,
  always_take_count: 5,
};


// Where the cycle was when it threw. The outer catch sees only the error, so a
// failed cycle answered with a bare "status code 500" that named nothing and
// could not be acted on. Every stage below sets this label before its awaits,
// so the error the desk shows says which part of the cycle stopped it.
export default async function (req) {
  let stage = "setup";
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const light = body.light === true;
    const dryRun = body.dry_run === true;

    // one set of rules only: keep the freshest config and remove stray older
    // ones, so every cycle and screen agrees on a single balance — scoped to
    // the requesting user, so a desk can never read or delete another user's
    // configuration
    const configs = asArray(
      await base44.entities.BotConfig.filter(
        { created_by_id: user.id },
        { sort: "-updated_date", limit: 10 },
      ),
    );
    if (!dryRun) for (const extra of configs.slice(1)) await base44.entities.BotConfig.delete(extra.id);
    let config = configs[0];
    if (!config && dryRun) return Response.json({ error: "Save bot rules before checking entries" }, { status: 400 });
    if (!config) config = await base44.entities.BotConfig.create(DEFAULT_CONFIG);

    // fully separate desk rules: the live desk reads only its own saved
    // live_rules and the standalone live defaults (deskRules) — a paper
    // value is never a fallback, so changing the paper desk can never move
    // the live one, and the other way around
    const LR = config.live_rules || {};
    const lrVal = (key, fb) => liveRule(LR, key, fb);
    const liveConfigView = { ...config, real_connection_id: lrVal("real_connection_id", "") || "" };
    const deskView = (desk) =>
      desk === "live" ? liveRulesView(config) : config;
    const liveView = deskView("live");
    const paperView = deskView("paper");
    // the V3 algorithm is a different strategy, not a filter on the scored
    // engines: a desk that runs it takes both its entries and its exits from
    // the daily gates — 2xATR stop, no target, a 30-bar horizon. Each desk
    // switches it on for itself (paper: v3_algo, live: live_rules.v3_algo).
    const v3On = (view) => view.v3_algo === true;
    // per-desk engine stack: engine flags and the target placement each desk
    // trades by (3R margin, 6R combo, 2.5R old engine)
    const deskEngine = (v) => {
      const engineV2 = v.engine_v2 !== false;
      const champion = v.champion_engine !== false;
      const comboOn = v.combo_engine !== false;
      const marginOn = v.margin_engine === true;
      return {
        engineV2,
        champion,
        comboOn,
        marginOn,
        leverage: Math.max(1, Math.min(5, Number(v.margin_leverage) || 2)),
        targetR: marginOn ? 3 : comboOn ? 6 : engineV2 && champion ? 2.5 : null,
      };
    };
    const paperEngine = deskEngine(paperView);
    const liveEngine = deskEngine(liveView);

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
        await base44.entities.BotConfig.filter(
          { created_by_id: user.id },
          { sort: "-updated_date", limit: 1 },
        ),
      )[0];
      claimConfirmed = !fresh || fresh.last_cycle_started_at === claim;
    }

    // light cycles only manage open positions — their prices come from the
    // batched live feed, so the whole-market fetch (and its cap-feed probes,
    // which took tens of seconds whenever a provider was down) is skipped
    // entirely: the desk load waits on this call, so it must stay fast
    // the venue this desk trades on: its own market snapshot, candles and
    // listings drive the scan, so every exchange the user connected is scanned
    // on the coins it actually lists
    stage = "markets";
    const scanVenue = light ? null : await resolveDeskVenue(base44, config);
    const { coins } = light ? { coins: [] } : await fetchMarkets(base44.asServiceRole, scanVenue);
    const priceMap = new Map(coins.map((c) => [c.symbol, c]));

    // Engine stacks resolve per desk (deskEngine above): each desk trades by
    // its own engine flags and target placement.

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
    // one parallel round instead of two serial waits — and the read is scoped
    // to the requesting user: another user's open paper positions are their
    // desk's business, never this cycle's (a shared read here let one desk's
    // exits close another user's trades)
    const [openTrades, managedRes] = await Promise.all([
      readAll({ status: "open", created_by_id: config.created_by_id || user.id }),
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
        // a margin short closes by buying the base quantity back, not selling —
        // through the venue's margin route so the debt is repaid with it
        const sell = await placeMarketOrder(managed.conn, {
          symbol: t.symbol,
          side: side === "short" ? "buy" : "sell",
          quantity: Number(t.quantity) || 0,
          ...(side === "short" ? { margin: true, leverage: liveEngine.leverage } : {}),
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
          ...(side === "short" ? { margin: true, leverage: liveEngine.leverage } : {}),
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
    stage = "positions";
    for (const t of dryRun ? [] : openTrades) {
      // a real fill the user logged by hand is theirs to manage — the bot only
      // touches its own real positions (those carry an exchange order id)
      if ((t.mode || "paper") === "real" && !t.exchange_order_id) continue;
      // manual mode: a buy the user placed by hand with bot handling off is
      // theirs alone — no stops, exits or sentiment until handling is turned on
      if (t.bot_handling === false) continue;
      const price = priceMap.get(t.symbol)?.price ?? null;
      if (!price) continue;
      const side = t.side === "short" ? "short" : "long";
      let entry = Number(t.entry_price) || 0;
      if (!entry) continue;
      // each position follows its own desk's rules: real positions are live-
      // desk trades, everything else is paper
      const isRealPos = (t.mode || "paper") === "real";
      const deskCfg = isRealPos ? liveView : paperView;
      const deskEng = isRealPos ? liveEngine : paperEngine;

      // ---- V3 positions exit on the algorithm's own rules, which are the ones
      // that were measured: a 2xATR daily stop and a 30-bar horizon, with no
      // target. The scored exits — target, break-even, trailing, scale-out,
      // pyramid and the sentiment pass — all change the tested rule, so they
      // are skipped here rather than layered on top of it.
      if (t.v3_algo === true) {
        const v3Stop = Number(t.v3_stop) || Number(t.stop_price) || 0;
        const due = v3ExitDue({
          trade: { v3_stop: v3Stop, v3_horizon_bars: t.v3_horizon_bars, opened_at: t.opened_at },
          price,
          nowMs: Date.now(),
        });
        if (due.exit) {
          const reason = due.reason;
          const ok = await closeOut(t, side, due.price, reason, {}, (pnl) => ({
            kind: reason === "stop" ? "stop_hit" : "bot_close",
            message:
              reason === "stop"
                ? `V3 stop hit at ${round(due.price, 8)} (2xATR below entry). P&L ${round(pnl)} USD.`
                : `V3 horizon reached: held ${due.days_held} daily bars, closed at ${round(due.price, 8)}. P&L ${round(pnl)} USD.`,
          }));
          if (!ok) continue;
          continue;
        }
        // still running: mark to market, and nothing else touches it
        const v3Qty = Number(t.quantity) || 0;
        const v3Size = Number(t.size_usd) || 0;
        const v3Unreal = side === "long" ? (price - entry) * v3Qty : (entry - price) * v3Qty;
        const v3Travelled = side === "long" ? price - entry : entry - price;
        const v3Unit = Math.abs(entry - v3Stop);
        positions.push({
          id: t.id,
          symbol: t.symbol,
          name: t.name,
          image: t.image,
          side,
          mode: t.mode || "paper",
          entry_price: entry,
          current_price: round(price, 8),
          stop_price: v3Stop ? round(v3Stop, 8) : null,
          target_price: null,
          size_usd: v3Size,
          pnl_usd: round(v3Unreal),
          pnl_pct: v3Size ? round((v3Unreal / v3Size) * 100) : 0,
          progress_pct: v3Unit
            ? round(Math.max(0, Math.min(100, (v3Travelled / v3Unit) * 100)))
            : 0,
          v3: true,
          v3_days_held: due.days_held,
          v3_horizon_bars: Number(t.v3_horizon_bars) || 30,
        });
        continue;
      }

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
      if (deskEng.engineV2 && targetR && target) {
        const bePct = ((Math.abs(target - entry) / targetR) / entry) * 100 * 1.2;
        if (gainPct >= bePct) {
          const be = side === "long" ? entry * 1.0005 : entry * 0.9995;
          if (side === "long" ? be > stop : be < stop) stop = be;
        }
      }

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
        !hitTarget && !hitStop && !hitMaxLoss &&
        targetR >= 4 && rUnitPct && !t.scaled &&
        gainPct >= rUnitPct * 3
      ) {
        const be = side === "long" ? entry * 1.0005 : entry * 0.9995;
        const newStop = side === "long" ? Math.max(stop, be) : Math.min(stop, be);
        if (await scaleOut(t, side, price, newStop)) continue;
      }
      const exit = hitTarget || hitStop || hitMaxLoss;

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
          : hitMaxLoss
            ? "max_loss"
            : "target";
        const ok = await closeOut(t, side, exitPrice, reason, updates, (pnl, pnlPct) => ({
          kind: reason === "target" ? "target_hit" : "stop_hit",
          message: `${
            reason === "target"
              ? "Target reached"
              : reason === "trailing"
                ? "Trailing stop hit"
                : reason === "max_loss"
                  ? "Max loss guard: the trade reached its per-trade loss cap"
                  : "Stop hit"
          } at ${round(exitPrice, 8)}. P&L ${round(pnl)} USD.`,
        }));
        if (!ok) continue;
      } else {
        // pyramiding: a desk that opts in adds to its winners. Once a trade
        // is up by the add trigger, another leg — half the opening size —
        // joins at market and the entry becomes the weighted average, so
        // exits and P&L stay honest. Position max is twice the opening
        // size: two add legs, never after the 3R scale-out, never on a
        // manual buy. The higher entry also re-arms break-even and
        // trailing against it on the next cycle, so the added size
        // manages exactly like the opening leg.
        const addsSoFar = Number(t.adds) || 0;
        const pyramidOn = isRealPos ? lrVal("pyramid", false) === true : config.pyramid === true;
        if (pyramidOn && t.manual !== true && !t.scaled && addsSoFar < 2) {
          const trigger =
            Number(isRealPos ? lrVal("pyramid_trigger_pct", 1.5) : (config.pyramid_trigger_pct ?? 1.5)) || 1.5;
          const origSize = (Number(t.size_usd) || 0) / (1 + 0.5 * addsSoFar);
          const addSize = round(origSize * 0.5, 2);
          if (gainPct >= trigger && origSize >= 10 && addSize >= 5) {
            let ok = true;
            let fill = price;
            if (isRealPos) {
              ok = false;
              if (
                live.conn != null && liveVerified && !isBackedOff(connRow) &&
                quoteLeft >= addSize * 1.01 && liveBudget >= addSize
              ) {
                const add = await placeMarketOrder(live.conn, {
                  symbol: t.symbol,
                  side: side === "short" ? "sell" : "buy",
                  usd: addSize,
                  price,
                  ...(side === "short" ? { margin: true, leverage: deskEng.leverage } : {}),
                });
                if (add.ok) {
                  fill = add.avg_price || price;
                  liveBudget -= addSize;
                  quoteLeft -= addSize * 1.005;
                  ok = true;
                } else {
                  console.log("pyramid order refused for " + t.symbol + ": " + (add.message || "unknown"));
                }
              } else {
                console.log("pyramid skipped for " + t.symbol + ": live desk not ready or over budget");
              }
            } else {
              cash -= addSize;
            }
            if (ok) {
              const addQty = round(addSize / fill, 8);
              const newQty = round((Number(t.quantity) || 0) + addQty, 8);
              const newEntry = round(
                ((entry * (Number(t.quantity) || 0)) + fill * addQty) / newQty,
                8,
              );
              entry = newEntry;
              t.entry_price = newEntry;
              t.quantity = newQty;
              t.size_usd = round((Number(t.size_usd) || 0) + addSize, 2);
              t.adds = addsSoFar + 1;
              updates.entry_price = newEntry;
              updates.quantity = newQty;
              updates.size_usd = t.size_usd;
              updates.adds = t.adds;
              await base44.entities.Alert.create({
                symbol: t.symbol,
                title: `${t.symbol} pyramided`,
                message: `Add ${t.adds} of 2: ${round(addSize, 2)} USD joined at ${round(fill, 8)} — the position now runs ${round(t.size_usd, 2)} USD with its entry at ${round(newEntry, 8)}.`,
                mode: isRealPos ? "live" : "paper",
                kind: "bot_open",
                severity: "info",
                trade_id: t.id,
              });
            }
          }
        }

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
    // sentiment watch runs per desk: each desk re-reads the charts behind its
    // own open positions with its own toggle, timeframe and engine stack
    const sentimentReads = new Map(); // "desk:symbol" -> fresh analysis
    const sentimentPass = async (desk, view, trades) => {
      if (view.sentiment_watch === false || !trades.length) return;
      const moves = coins
        .map((c) => c.change24h)
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);
      const medianChange24h = moves.length ? moves[Math.floor(moves.length / 2)] : 0;
      const tf = view.timeframe || "1h";
      for (const group of chunk([...new Set(trades.map((t) => t.symbol))], 6)) {
        const settled = await Promise.allSettled(
          group.map((s) => fetchCandles(s, tf, 300)),
        );
        settled.forEach((res, i) => {
          if (res.status !== "fulfilled" || !res.value) return;
          const coin = priceMap.get(group[i]);
          if (!coin) return;
          const row = analyzeCoin(coin, res.value, {
            medianChange24h,
            dailyTargetPct: Number(view.daily_target_pct) || 2,
            barsPerDay:
              { "15m": 96, "1h": 24, "4h": 6, "12h": 2, "1d": 1, "1w": 1 / 7, "1M": 1 / 30 }[tf] || 24,
            confluenceV2: view.confluence_v2 !== false,
          });
          if (row) sentimentReads.set(`${desk}:${group[i]}`, row);
        });
      }
    };
    stage = "sentiment";
    if (!light) {
      await sentimentPass("paper", paperView, sentinel.filter((t) => (t.mode || "paper") !== "real"));
      await sentimentPass("live", liveView, sentinel.filter((t) => (t.mode || "paper") === "real"));
    }
    for (const t of sentinel) {
      // manual buys trade the sell logic only: stops, targets and trailing —
      // never a sentiment flip or a thesis-decay close
      if (t.manual === true) continue;
      const row = sentimentReads.get(`${(t.mode || "paper") === "real" ? "live" : "paper"}:${t.symbol}`);
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
    let v3Summary = null;
    // portfolio risk state for the paper desk: filled in when this cycle
    // actually looks for entries, surfaced in the response for the bot page
    let paperRisk = null;
    // the guarded stages' failure reasons, reported for the page. They are
    // declared here, not inside the scan block below, because the cycle's
    // response reads them whether or not that block ran: a light cycle — the
    // desk's cheap refresh — skips the block, so the read threw
    // "riskError is not defined" and took the whole call down with a 500.
    let riskError = null;
    let v3Error = null;

    const scanGateOpen =
      paperOpenCount < paperMaxOpen ||
      (live.conn != null && liveVerified && liveOpenCount < liveMaxOpen);

    stage = "scan";
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
        feed: scanVenue,
      });
      // the live desk scans its own board when its scan settings differ from
      // the paper desk's — separate desks, separate scans; matching settings
      // share one board so the cycle never scans the market twice needlessly
      const liveScanDiffers =
        String(liveView.timeframe || "1h") !== String(config.timeframe || "1h") ||
        String(liveView.market_cap_scope || "all") !== String(config.market_cap_scope || "all") ||
        (liveView.confluence_v2 !== false) !== (config.confluence_v2 !== false);
      let liveBoard = board;
      if (live.conn != null && liveVerified && liveScanDiffers) {
        liveBoard = await scanBoard({
          timeframe: liveView.timeframe || "1h",
          scope: liveView.market_cap_scope || "all",
          count: 60,
          dailyTargetPct: Number(lrVal("daily_target_pct", 2)) || 2,
          extraSymbols: watch.map((w) => w.symbol),
          ...(listed ? { onlySymbols: listed } : {}),
          confluenceV2: liveView.confluence_v2 !== false,
          feed: scanVenue,
        });
      }

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
      // proposals block their own desk only: a live proposal must not freeze the
      // paper desk's symbol, and the other way around
      const pendingLive = pending
        .filter((t) => (t.mode || "paper") === "real")
        .map((t) => t.symbol);
      const pendingPaper = pending
        .filter((t) => (t.mode || "paper") !== "real")
        .map((t) => t.symbol);
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
        ...pendingLive,
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
        ...pendingPaper,
      ]);

      // trading style bends the rules without touching what the user saved:
      // timid waits for stronger setups with less at stake, aggressive
      // accepts more setups and stakes more to reach the goal faster
      // trading style bends each desk's rules without touching what the user
      // saved: timid waits for stronger setups with less at stake, aggressive
      // accepts more setups and stakes more to reach the goal faster
      const styleRiskFor = (style) => (style === "timid" ? 0.75 : style === "aggressive" ? 1.4 : 1);
      // BTC's 24h tape drives the combo regime gate (risk-off longs, flat-tape skips)
      const btcChange = (coins.find((c) => c.symbol === "BTC") || {}).change24h ?? null;
      const rulesByDesk = {
        live: entryRulesFor(liveView, "live", btcChange),
        paper: entryRulesFor(paperView, "paper", btcChange),
      };
      const entryGate = (r, desk) => gateReasonShared(r, desk, rulesByDesk[desk]);
      const liveSlots = Math.max(1, liveMaxOpen - liveOpenCount);
      // ---- portfolio risk controls (shared/risk.ts). Everything here is a
      // restriction: a drawdown brake, a daily loss halt, a losing-streak
      // reduction and a concentration cap, computed from the paper desk's own
      // closed trades. The live desk keeps its existing caps (live_cap_usd and
      // the per-trade loss guard): it has no stored equity baseline, so a
      // drawdown measured there would be measuring nothing. Wiring it needs
      // one, and that is a separate change.
      //
      // A failure here must not kill the cycle: it fails closed instead —
      // no new paper entries — and the reason is returned for the page.
      riskError = null;
      try {
        const riskWindow = await readAll({
          status: "closed",
          closed_at: { $gte: new Date(Date.now() - 180 * 86400000).toISOString() },
        });
        const paperClosed = riskWindow
          .filter((t) => (t.mode || "paper") === "paper")
          .sort((a, b) => String(b.closed_at || "").localeCompare(String(a.closed_at || "")));
        const riskDayStart = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
        paperRisk = riskState({
          starting_balance: Number(config.starting_balance) || 10000,
          realized_pnl_total: paperClosed.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0),
          realized_pnl_today: paperClosed
            .filter((t) => t.closed_at && Date.parse(t.closed_at) >= riskDayStart)
            .reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0),
          open_size_usd: stillOpen
            .filter((t) => (t.mode || "paper") === "paper")
            .reduce((a, t) => a + (Number(t.size_usd) || 0), 0),
          losing_streak: losingStreak(paperClosed),
        });
      } catch (err) {
        riskError = String((err && err.message) || err);
        console.log(`risk check failed: ${riskError}`);
        paperRisk = {
          size_multiplier: 0,
          block_entries: true,
          reason: `risk check failed (${riskError})`,
          drawdown_pct: 0,
          realized_pnl_today: 0,
          losing_streak: 0,
          deployed_usd: 0,
        };
      }
      const riskPct = Math.min(
        25,
        (Number(paperView.risk_per_trade_pct) || 4) * styleRiskFor(paperView.trading_style || "mild"),
      ) * (paperRisk.block_entries ? 0 : paperRisk.size_multiplier);

      // self-teaching: past results per pattern (side x cap tier) nudge scores
      const lessons = await loadLessons(base44);
      const lessonMap = new Map(lessons.map((l) => [l.pattern, l]));

      // smart money: where the top on-chain traders are positioned nudges
      // scores the same way — aligned with their flow, capped at +-5 points
      const smartBias = await loadSmartBias(base44);

      const applyEdges = (rows) => rows.map((r) => {
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
      const tradable = applyEdges(board.rows);
      const tradableLive = liveBoard === board ? tradable : applyEdges(liveBoard.rows);

      // engine targets: 6R from entry with the combo stack on (the pooled
      // flat-tape winner), 3R under the margin engine, 2.5R under the old
      // engine rules - always on the trade's own side, so the distance is
      // |entry - stop| measured outward. Each desk targets by its own stack.
      const engineTargetFor = (eng) => (r) => {
        const dist = (eng.targetR || 2.5) * Math.abs(r.entry - r.stop);
        return round(r.side === "long" ? r.entry + dist : r.entry - dist, 8);
      };
      const useEngineTargetFor = (eng) => eng.marginOn || eng.comboOn || (eng.engineV2 && eng.champion);
      const paperEngineTarget = engineTargetFor(paperEngine);
      const liveEngineTarget = engineTargetFor(liveEngine);
      const paperUseEngine = useEngineTargetFor(paperEngine);
      const liveUseEngine = useEngineTargetFor(liveEngine);
      // ---- V3 algorithm: one board, a third rule set. The daily gates are
      // read once per candidate per cycle (capped, in batches) and answer both
      // desks, because none of them depends on the desk. The candidate list is
      // every scanned symbol, not just the ones the intraday scan calls long:
      // V3 is a daily strategy and must not inherit the 1h side. When BTC's
      // daily trend cannot be read, the regime gate fails closed: no entries.
      const v3DeskOn = { live: v3On(liveView), paper: v3On(paperView) };
      const v3Evals = new Map();
      v3Error = null;
      if (v3DeskOn.live || v3DeskOn.paper) {
        try {
          const candidates = new Set();
          for (const r of [...tradable, ...tradableLive]) {
            if (r.symbol) candidates.add(r.symbol);
          }
          const wanted = [...candidates].slice(0, 40);
          const btcDaily = await fetchCandles("BTC", "1d", 260, scanVenue).catch(() => null);
          const btcAbove = btcTrendUp(btcDaily);
          for (const group of chunk(wanted, 6)) {
            const settled = await Promise.allSettled(
              group.map((s) => fetchCandles(s, "1d", 260, scanVenue)),
            );
            settled.forEach((res, i) => {
              if (res.status !== "fulfilled" || !res.value) return;
              v3Evals.set(group[i], evaluateV3({
                candles: res.value,
                btcAboveSma200: btcAbove,
                profile: config.v3_profile || "loose",
              }));
            });
          }
          const gates = { history: 0, entry_signal: 0, liquidity: 0, regime: 0, confluence: 0 };
          let entries = 0;
          for (const ev of v3Evals.values()) {
            if (ev.state === "entry") {
              entries += 1;
              continue;
            }
            const g = ev.gates || {};
            if (!g.history) gates.history += 1;
            else if (!g.entry_signal) gates.entry_signal += 1;
            else if (!g.liquidity) gates.liquidity += 1;
            else if (!g.regime) gates.regime += 1;
            else gates.confluence += 1;
          }
          v3Summary = {
            desks: v3DeskOn,
            candidates: wanted.length,
            evaluated: v3Evals.size,
            entries,
            btc_above: btcAbove,
            gates,
          };
        } catch (err) {
          // a V3 failure costs V3 entries, never the whole cycle
          v3Error = String((err && err.message) || err);
          console.log(`v3 evaluation failed: ${v3Error}`);
          v3Summary = { desks: v3DeskOn, evaluated: 0, entries: 0, error: v3Error };
        }
      }
      // a V3 row trades the algorithm's own plan: its stop, no target, and it
      // is a long whatever the intraday scan said
      // V3 only rewrites a row on a desk that runs V3. The evaluations are
      // shared (they are daily reads that ignore the desk), but the plan is not:
      // without this guard a paper-only V3 switch would rewrite the live desk's
      // entries as V3 longs.
      const withV3 = (row, desk) => {
        if (!v3DeskOn[desk]) return row;
        const ev = v3Evals.get(row.symbol);
        if (!ev || ev.state !== "entry") return row;
        const plan = v3Plan({ entryPx: row.entry, atr: ev.atr });
        if (!plan) return row;
        const formation = ev.formations.length ? ` with ${ev.formations.join(", ")}` : "";
        return {
          ...row,
          side: "long",
          stop: round(plan.stop, 8),
          target: null,
          required_move_pct: null,
          v3: ev,
          reasons: [
            ...(row.reasons || []),
            `V3: ${ev.entry_signal.join(" + ")}${formation} on the daily close, stop 2xATR, no target, ${ev.horizon_bars}-bar horizon`,
          ],
        };
      };
      const qualifies = (r, desk) => {
        const blocked = desk === "live" ? blockedLive : blockedPaper;
        if (blocked.has(r.symbol)) return false;
        // the paper desk's risk brakes come before any setup is considered
        if (desk === "paper" && paperRisk && paperRisk.block_entries) return false;
        if (v3DeskOn[desk]) {
          // the researched gates replace the score bar and the intraday side on
          // this desk; the plan must also produce a usable stop
          const ev = v3Evals.get(r.symbol);
          if (!ev || ev.state !== "entry") return false;
          return v3Plan({ entryPx: r.entry, atr: ev.atr }) != null;
        }
        return entryGate(r, desk) === null;
      };
      // a live short is a margin order: only a venue whose margin API the desk
      // can place through may take one, so a spot-only account is never handed
      // a setup it would fill as a plain sell
      const liveShorts = live.conn ? SHORT_VENUES.has(live.conn.exchange) : false;
      // ---- always-take top picks: a desk can opt into buying its highest
      // scoring coins whether or not they clear the entry gates. Only entry
      // quality is bypassed: the row keeps its own stop, target and trailing,
      // and the desk's risk sizing, cooldowns, open-position guard, slot limit,
      // exchange listing filter, approve mode and paper risk brakes all still
      // apply. A desk running V3 does not mix in top picks.
      const topCount = (view) => Math.max(1, Math.min(10, Number(view.always_take_count) || 5));
      const topPicksFor = (rows, desk, count, exclude) => {
        const blocked = desk === "live" ? blockedLive : blockedPaper;
        const openSymbols = new Set(stillOpen.map((t) => t.symbol));
        if (exclude) for (const symbol of exclude) openSymbols.add(symbol);
        return pickTopPicks(rows, {
          blocked,
          openSymbols,
          allowShorts: desk === "live"
            ? liveShorts && liveView.allow_shorts !== false
            : paperView.allow_shorts !== false,
          count,
          // wait for a good entry into the pick rather than chasing it
          requireEntry: true,
        });
      };
      const liveReady = live.conn && liveVerified && !isBackedOff(connRow);
      const liveGated = liveReady
        ? tradableLive
            .filter((r) => qualifies(r, "live") && (v3DeskOn.live || r.side === "long" || liveShorts))
            .map((r) => withV3(r, "live"))
        : [];
      const liveTop = liveReady && liveView.always_take_top === true && !v3DeskOn.live
        ? topPicksFor(tradableLive, "live", topCount(liveView))
        : [];
      const liveWanted = [...liveGated, ...liveTop]
        .filter((r, index, all) => all.findIndex((x) => x.symbol === r.symbol) === index)
        .slice(0, Math.max(0, liveMaxOpen - liveOpenCount));
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
      const liveRiskPct = Math.min(
        25,
        (Number(lrVal("risk_per_trade_pct", 4)) || 4) * styleRiskFor(liveView.trading_style || "mild"),
      );
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
      const paperGated = tradable
        .filter((r) => !liveSymbols.has(r.symbol) && qualifies(r, "paper"))
        .map((r) => withV3(r, "paper"));
      const paperTop = paperView.always_take_top === true && !v3DeskOn.paper
        ? topPicksFor(tradable, "paper", topCount(paperView), liveSymbols)
        : [];
      const paperWanted = [...paperGated, ...paperTop]
        .filter((r, index, all) => all.findIndex((x) => x.symbol === r.symbol) === index)
        .slice(0, Math.max(0, paperMaxOpen - paperOpenCount));
      if (dryRun) {
        const plans = [];
        for (const r of liveWanted) {
          if (stillOpen.some(t => t.symbol === r.symbol)) continue;
          const rl = atLive(r);
          const size = sizeLive(rl, Math.max(1, liveSlots - plans.length));
          if (!size) continue;
          plans.push({ symbol: r.symbol, side: r.side, score: r.score, size_usd: size,
            entry: rl.entry, stop: r.stop, target: liveUseEngine ? liveEngineTarget(rl) : r.target });
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
            taken: { live: plans.length, paper: paperWanted.length } }),
          v3: v3Summary });
      }
      const takenSymbols = new Set([...liveWanted, ...paperWanted].map((r) => r.symbol));
      scanLog = {
        scanned: board.scannedCount,
        blocked: 0,
        below_score: tradable.filter((r) => !takenSymbols.has(r.symbol)).length,
        taken: takenSymbols.size,
      };

      stage = "entries";
      for (const { r, desk } of [
        ...liveWanted.map((row) => ({ r: row, desk: "live" })),
        ...paperWanted.map((row) => ({ r: row, desk: "paper" })),
      ]) {
        // final guard: even if a paged read missed it, never open a second
        // position in a symbol that already has one open
        const alreadyOpen = await base44.entities.Trade.count({
          status: "open",
          symbol: r.symbol,
          created_by_id: config.created_by_id || user.id,
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
        // concentration cap: no single position may exceed the desk's share of
        // equity, whatever the risk maths asked for
        const riskCapped = capPositionSize(sizeUsd, Number(config.starting_balance) || 10000);
        if (riskCapped < sizeUsd && riskCapped >= 10) {
          sizeUsd = riskCapped;
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
            ...(isShort ? { margin: true, leverage: liveEngine.leverage } : {}),
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
            target_price: r.v3 ? null : liveUseEngine ? liveEngineTarget(rl) : r.target,
            target_r: r.v3 ? 0 : liveEngine.targetR,
            ...(r.v3
              ? {
                  v3_algo: true,
                  v3_stop: round(r.stop, 8),
                  v3_horizon_bars: r.v3.horizon_bars,
                  v3_atr: round(r.v3.atr, 8),
                }
              : {}),
            peak_price: real.avg_price || rl.entry,
            score: r.score,
            pattern: `${r.side}/${r.market_cap_bucket}`,
            entry_source: r.v3 ? "v3" : r.top_pick ? "top_pick" : "gated",
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
              message: r.v3
                ? `Entry ${r.entry}, V3 stop ${r.stop} (2xATR daily). No target: held up to ${r.v3.horizon_bars} daily bars. Real order placed on ${live.conn.label}.`
                : `Entry ${r.entry}, target ${r.target} (${r.required_move_pct}% move), stop ${r.stop}. Score ${r.score}. Real order placed on ${live.conn.label}.`,
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
          target_price: r.v3 ? null : paperUseEngine ? paperEngineTarget(r) : r.target,
          target_r: r.v3 ? 0 : paperEngine.targetR,
          ...(r.v3
            ? {
                v3_algo: true,
                v3_stop: round(r.stop, 8),
                v3_horizon_bars: r.v3.horizon_bars,
                v3_atr: round(r.v3.atr, 8),
              }
            : {}),
          peak_price: r.entry,
          score: r.score,
          pattern: `${r.side}/${r.market_cap_bucket}`,
          entry_source: r.v3 ? "v3" : r.top_pick ? "top_pick" : "gated",
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
            message: r.v3
              ? `Entry ${r.entry}, V3 stop ${r.stop} (2xATR daily). No target: held up to ${r.v3.horizon_bars} daily bars.`
              : `Entry ${r.entry}, target ${r.target} (${r.required_move_pct}% move), stop ${r.stop}. Score ${r.score}.`,
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
    stage = "stats";
    const [todays, realizedAgg, deployedAgg, prevCandlesPage, existingCandlePage, prevLivePage, existingLivePage] =
      await Promise.all([
        readAll({ status: "closed", closed_at: { $gte: dayStart.toISOString() }, created_by_id: user.id }),
        base44.entities.Trade.aggregate({ query: { status: "closed", mode: "paper", created_by_id: user.id }, sum: "pnl_usd" }),
        base44.entities.Trade.aggregate({ query: { status: "open", mode: "paper", created_by_id: user.id }, sum: "size_usd" }),
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
    stage = "exchange balance";
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
    stage = "wallet sync";
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
          targetR: liveEngine.targetR || 0,
        });
        await base44.entities.BotConfig.update(config.id, { last_wallet_sync_at: Date.now() });
      }
    }

    // ---- live desk extras: the day's goal (the live target pct of the
    // exchange balance, saved balance when the live read failed) plus the
    // best and worst closed real trades of the day, so the desk can render
    // its progress and day movers without a second read
    const liveDayPct = Number(lrVal("daily_target_pct", 2)) || 2;
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
    stage = "equity";
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
        const dist = (paperEngine.marginOn ? 3 : 6) * Math.abs(r.entry - r.stop);
        const target =
          (paperEngine.marginOn || paperEngine.comboOn) && r.entry > 0 && r.stop > 0 && r.entry !== r.stop
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
      v3: v3Summary,
      risk: paperRisk,
      diagnostics: { risk_error: riskError, v3_error: v3Error },
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
    const message = String((error && error.message) || error);
    return Response.json({ error: `${stage}: ${message}` }, { status: 500 });
  }
}