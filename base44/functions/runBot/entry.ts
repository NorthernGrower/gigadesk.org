import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, fetchCandles, chunk, asArray, round } from "../../shared/market.ts";
import { analyzeCoin } from "../../shared/strategy.ts";
import { scanBoard } from "../../shared/scan.ts";
import { QUOTE_ASSET, placeMarketOrder, resolveLiveConnection } from "../../shared/orders.ts";
import { readAccount, fetchListedSymbols, pickQuoteBalance, pickFundingQuote, isBackedOff, backoffUntil, balanceJustRead } from "../../shared/exchanges.ts";
import { loadLessons, recordLesson } from "../../shared/learn.ts";
import { gateReason as gateReasonShared, collectGateLocks, raiseGateLockAlerts } from "../../shared/rulelock.ts";
import { loadSmartBias } from "../../shared/smartmoney.ts";

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

    // one set of rules only: keep the freshest config and remove stray older
    // ones, so every cycle and screen agrees on a single balance
    const configs = asArray(
      await base44.entities.BotConfig.filter({}, { sort: "-updated_date", limit: 10 }),
    );
    for (const extra of configs.slice(1)) await base44.entities.BotConfig.delete(extra.id);
    let config = configs[0];
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
    const cycleInFlight = !light && startedAt > 0 && Date.now() - startedAt < 45000;
    if (!light)
      await base44.entities.BotConfig.update(config.id, {
        last_cycle_started_at: new Date().toISOString(),
      });

    const { coins } = await fetchMarkets();
    const priceMap = new Map(coins.map((c) => [c.symbol, c]));

    // engine_v2: the optimizer-winning rules (seven Kraken rounds, recorded in
    // AuditRun). BTC's 24h tape gates longs: risk-on and sideways entries
    // measured the weakest in every round, so longs fire only in a risk-off tape.
    const engineV2 = config.engine_v2 !== false;
    // champion refinements on top of the entry rules (toggleable): 2.5R
    // targets with break-even after +1.2R, 1.5x volume and risk-off longs only
    const champion = config.champion_engine !== false;
    const btcChange = Number(priceMap.get("BTC")?.change24h) || 0;
    const btcRegime = btcChange > 1 ? "risk_on" : btcChange < -1 ? "risk_off" : "sideways";

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
    const openTrades = await readAll({ status: "open" });
    // managing existing real positions must work even while new live entries
    // are paused — the pause gates entries, never risk management
    const managed = await resolveLiveConnection(base44, liveConfigView, { manage: true });
    const live = config.real_orders_enabled === true
      ? managed
      : { conn: null, reason: "Live trading is paused", info: managed.info };
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
        const sell = await placeMarketOrder(managed.conn, {
          symbol: t.symbol,
          side: "sell",
          quantity: Number(t.quantity) || 0,
        });
        if (!sell.ok) {
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
      await base44.entities.Alert.create({
        symbol: t.symbol,
        title: `${t.symbol} closed ${pnl >= 0 ? "in profit" : "at a loss"} (${round(pnlPct)}%)`,
        message: meta.message || "",
        mode: (t.mode || "paper") === "real" ? "live" : "paper",
        kind: meta.kind || "bot_close",
        severity: pnl >= 0 ? "success" : "danger",
        trade_id: t.id,
      });
      // remember the call: its pattern now carries this result into future scans
      await recordLesson(base44, t, pnlPct, pnl, reason);
      return true;
    }

    // ---- manage the positions already open
    for (const t of openTrades) {
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
      const trailingOn = isRealPos
        ? lrVal("trailing_stop", true) !== false
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
      const exit = hitTarget || hitStop || stagnant;

      if (exit) {
        const exitPrice = stagnant ? price : hitTarget ? target : stop;
        const reason = stagnant
          ? "time"
          : hitTarget
            ? "target"
            : updates.stop_price
              ? "trailing"
              : "stop";
        const ok = await closeOut(t, side, exitPrice, reason, updates, (pnl, pnlPct) => ({
          kind: reason === "time" ? "bot_close" : reason === "target" ? "target_hit" : "stop_hit",
          message: `${
            reason === "target"
              ? "Target reached"
              : reason === "trailing"
                ? "Trailing stop hit"
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
    if (!light) {
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
      paperOpenCount < paperMaxOpen || (live.conn != null && liveOpenCount < liveMaxOpen);

    if (!light && config.mode !== "off" && scanGateOpen && !cycleInFlight) {
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
      const pending = await readAll({ status: "proposed" });
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
      const styleScore = style === "timid" ? 6 : style === "aggressive" ? -5 : 0;
      const styleRisk = style === "timid" ? 0.75 : style === "aggressive" ? 1.4 : 1;
      // the engine's own verdict scale calls anything under 58 "avoid", so
      // the bar can never drop into grades the engine itself would not take
      const paperMinScore = Math.max(58, (Number(config.min_score) || 62) + styleScore);
      const liveMinScore = Math.max(58, (Number(lrVal("min_score", 62)) || 62) + styleScore);
      const allowShorts = config.allow_shorts !== false;
      const paperRequireTarget = config.require_daily_target !== false;
      const liveRequireTarget = lrVal("require_daily_target", true) !== false;
      const paperTargetPct = Number(config.daily_target_pct) || 2;
      const liveTargetPct = Number(lrVal("daily_target_pct", 2)) || 2;
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

      // engine_v2 targets: 2.5R from entry, the optimizer winner
      // 2.5R from entry, on the trade's own side: the stop sits opposite the
      // target, so the distance is always |entry - stop| measured outward
      const engineTarget = (r) => {
        const dist = 2.5 * Math.abs(r.entry - r.stop);
        return round(r.side === "long" ? r.entry + dist : r.entry - dist, 8);
      };
      const qualifies = (r, desk) => {
        const blocked = desk === "live" ? blockedLive : blockedPaper;
        const minScore = desk === "live" ? liveMinScore : paperMinScore;
        const requireTarget = desk === "live" ? liveRequireTarget : paperRequireTarget;
        const targetPct = desk === "live" ? liveTargetPct : paperTargetPct;
        if (blocked.has(r.symbol) || r.score < minScore) return false;
        // real orders are longs only — shorts stay paper
        if (desk === "live" ? r.side !== "long" : !allowShorts && r.side !== "long") return false;
        // engine_v2 entry quality: higher-timeframe confirmation, momentum
        // strength, structure confluence, 1.5x volume, a bounded stretch and
        // no chasing — the rule set that turned the 30-day Kraken backtest
        // from -8.6% to +8.3% with a 1.6% max drawdown
        if (engineV2) {
          if (champion && r.side === "long" && btcRegime !== "risk_off") return false;
          if (!r.htf_trend || r.htf_trend !== (r.side === "long" ? "up" : "down")) return false;
          const ind = r.indicators || {};
          if ((Number(ind.adx) || 0) < 25) return false;
          const diOwned =
            r.side === "long"
              ? (Number(ind.plus_di) || 0) > (Number(ind.minus_di) || 0)
              : (Number(ind.minus_di) || 0) > (Number(ind.plus_di) || 0);
          if (!diOwned) return false;
          if ((r.confluence || 0) < 3) return false;
          if ((Number(ind.vol_ratio) || 0) < (champion ? 1.5 : 1.2)) return false;
          if (ind.ema20) {
            const stretch = ((r.price - ind.ema20) / ind.ema20) * 100 * (r.side === "long" ? 1 : -1);
            if (stretch > 5) return false;
          }
          if (r.fib_phase === "chasing") return false;
        }
        if (!requireTarget) return true;
        if (champion && engineV2) {
          const stopPct = (Math.abs(r.entry - r.stop) / r.entry) * 100;
          return 2.5 * stopPct >= targetPct && r.score >= 58;
        }
        return Number(r.required_move_pct) >= targetPct && r.score >= 58;
      };
      const liveWanted = live.conn
        ? tradable
            .filter((r) => qualifies(r, "live"))
            .slice(0, Math.max(0, liveMaxOpen - liveOpenCount))
        : [];
      // a desk with qualifying setups but nothing to pay with should say so
      // once (throttled), instead of firing order attempts into a wall of
      // exchange-side insufficient-funds failures every cycle
      if (live.conn && liveWanted.length && spendableQuote < 10) {
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
      const liveSymbols = new Set(liveWanted.map((r) => r.symbol));
      const paperWanted = tradable
        .filter((r) => !liveSymbols.has(r.symbol) && qualifies(r, "paper"))
        .slice(0, Math.max(0, paperMaxOpen - paperOpenCount));

      const gateReason = (r, desk) =>
        gateReasonShared(r, desk, {
          min_score: desk === "live" ? liveMinScore : paperMinScore,
          allow_shorts: allowShorts !== false,
          engine_v2: engineV2,
          champion,
          btc_regime: btcRegime,
          require_target: desk === "live" ? liveRequireTarget : paperRequireTarget,
          target_pct: desk === "live" ? liveTargetPct : paperTargetPct,
        });
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
        if (desk === "live" && live.conn && liveBudget >= 10 && spendableQuote >= 10) {
          const liveRiskPct = Math.min(25, (Number(lrVal("risk_per_trade_pct", 4)) || 4) * styleRisk);
          const liveFreeSlots = Math.max(1, liveSlots - opened.filter((o) => o.mode === "real").length);
          const liveRiskUsd = (spendableQuote * liveRiskPct) / 100;
          realSizeUsd = Math.min(
            (liveRiskUsd / stopDist) * r.entry,
            spendableQuote / liveFreeSlots,
            liveBudget,
            spendableQuote,
          );
          if (realSizeUsd >= 10) {
            real = await placeMarketOrder(live.conn, {
              symbol: r.symbol,
              side: "buy",
              usd: round(realSizeUsd, 2),
              price: r.entry,
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
          }
        }

        if (real) {
          const created = await base44.entities.Trade.create({
            symbol: r.symbol,
            name: r.name,
            image: r.image,
            side: r.side,
            mode: "real",
            status: config.mode === "auto" ? "open" : "proposed",
            entry_price: round(real.avg_price || r.entry, 8),
            quantity: round(real.filled_qty || realSizeUsd / r.entry, 8),
            size_usd: round(realSizeUsd),
            stop_price: r.stop,
            target_price: engineV2 && champion ? engineTarget(r) : r.target,
            target_r: engineV2 && champion ? 2.5 : null,
            peak_price: r.entry,
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
          target_price: engineV2 ? engineTarget(r) : r.target,
          target_r: engineV2 ? 2.5 : null,
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
    const todays = await readAll({
      status: "closed",
      closed_at: { $gte: dayStart.toISOString() },
    });
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
        exchangeBalance = await pickQuoteBalance(acct.balances, managed.conn.exchange);
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
    const [realizedAgg, deployedAgg] = await Promise.all([
      base44.entities.Trade.aggregate({ query: { status: "closed", mode: "paper" }, sum: "pnl_usd" }),
      base44.entities.Trade.aggregate({ query: { status: "open", mode: "paper" }, sum: "size_usd" }),
    ]);
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
    const equity = startBalance + realizedTotal + unrealized;

    await base44.entities.BotConfig.update(config.id, {
      cash_balance: round(anchoredCash),
      last_run_at: new Date().toISOString(),
    });

    // ---- save today's equity candle so the chart keeps its history even as
    // old trades age out of the journal
    const todayKey = new Date().toISOString().slice(0, 10);
    const paperRealizedToday = realizedToday;
    // candles are per-user: one app user's equity chart must not overwrite
    // another's, so every write carries the owner and keys on owner + day
    const prevCandles = asArray(
      await base44.entities.EquityCandle.filter(
        { owner: user.id, day: { $lt: todayKey } },
        { sort: "-day", limit: 1 },
      ),
    );
    const prevClose = prevCandles.length ? Number(prevCandles[0].close) : null;
    const existingCandle = asArray(
      await base44.entities.EquityCandle.filter(
        { owner: user.id, day: todayKey },
        { limit: 1 },
      ),
    )[0];
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
      const prevLiveCandles = asArray(
        await base44.entities.EquityCandle.filter(
          { owner: liveOwner, day: { $lt: todayKey } },
          { sort: "-day", limit: 1 },
        ),
      );
      const prevLiveClose = prevLiveCandles.length ? Number(prevLiveCandles[0].close) : null;
      const existingLive = asArray(
        await base44.entities.EquityCandle.filter(
          { owner: liveOwner, day: todayKey },
          { limit: 1 },
        ),
      )[0];
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
      top: (board.rows || []).slice(0, 12).map((r) => ({
        ...r,
        pair: `${r.symbol}/${(managed.conn && (managed.conn.quoteAsset || QUOTE_ASSET[managed.conn.exchange])) || "USDT"}`,
        exchange: managed.conn ? managed.conn.exchange : null,
      })),
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
        entry_ready: config.real_orders_enabled === true && live.conn != null,
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
      open_count: positions.length,
      config,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}