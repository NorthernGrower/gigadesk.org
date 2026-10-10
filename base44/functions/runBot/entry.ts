import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, asArray, round } from "../../shared/market.ts";
import { scanBoard } from "../../shared/scan.ts";
import { QUOTE_ASSET, placeMarketOrder, resolveLiveConnection } from "../../shared/orders.ts";
import { readAccount } from "../../shared/exchanges.ts";
import { loadLessons, recordLesson } from "../../shared/learn.ts";

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
  trailing_trigger_pct: 1,
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
  trading_style: "mild",
};

// An aggressive-style trade that has gone nowhere for a quarter of the scan
// timeframe is cut so the capital moves on to fresher setups.
const TIMEFRAME_MS = {
  "15m": 15 * 60000,
  "1h": 60 * 60000,
  "4h": 4 * 60 * 60000,
  "1d": 24 * 60 * 60000,
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

    const { coins } = await fetchMarkets();
    const priceMap = new Map(coins.map((c) => [c.symbol, c]));

    const openTrades = asArray(
      await base44.entities.Trade.filter({ status: "open" }, { limit: 50 }),
    );
    const live = await resolveLiveConnection(base44, config);
    let cash = Number(config.cash_balance) || 0;
    const closed = [];
    const positions = [];

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

      if (config.trailing_stop) {
        if (side === "long" && price > peak) peak = price;
        if (side === "short" && price < peak) peak = price;
        if (gainPct >= Number(config.trailing_trigger_pct ?? 1)) {
          const dist = Number(config.trailing_distance_pct ?? 1.5) / 100;
          const trail = side === "long" ? peak * (1 - dist) : peak * (1 + dist);
          if (side === "long" && trail > stop) stop = trail;
          if (side === "short" && trail < stop) stop = trail;
        }
        if (peak !== prevPeak) updates.peak_price = round(peak, 6);
      }
      if (stop !== Number(t.stop_price)) updates.stop_price = round(stop, 6);

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
        Math.abs(gainPct) < 1;
      const exit = hitTarget || hitStop || stagnant;

      if (exit) {
        let exitPrice = stagnant ? price : hitTarget ? target : stop;
        // close a bot-placed real position with a real sell order; if the
        // exchange refuses, the position stays open and the user is alerted
        if (t.mode === "real" && live.conn) {
          const sell = await placeMarketOrder(live.conn, {
            symbol: t.symbol,
            side: "sell",
            quantity: Number(t.quantity) || 0,
          });
          if (!sell.ok) {
            await base44.entities.Alert.create({
              symbol: t.symbol,
              title: `Could not close ${t.symbol} on ${live.conn.label}`,
              message: sell.message,
              kind: "order_failed",
              severity: "danger",
              trade_id: t.id,
            });
            if (Object.keys(updates).length) await base44.entities.Trade.update(t.id, updates);
            continue;
          }
          if (sell.avg_price) exitPrice = sell.avg_price;
        }
        const qty = Number(t.quantity) || 0;
        const size = Number(t.size_usd) || 0;
        const pnl = side === "long" ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
        const pnlPct = size ? (pnl / size) * 100 : 0;
        const reason = stagnant
          ? "time"
          : hitTarget
            ? "target"
            : updates.stop_price
              ? "trailing"
              : "stop";

        await base44.entities.Trade.update(t.id, {
          ...updates,
          status: "closed",
          exit_price: round(exitPrice, 6),
          pnl_usd: round(pnl),
          pnl_pct: round(pnlPct),
          closed_at: new Date().toISOString(),
          exit_reason: reason,
        });
        if ((t.mode || "paper") === "paper") cash += size + pnl;
        closed.push({
          id: t.id,
          symbol: t.symbol,
          side,
          exit_price: round(exitPrice, 6),
          pnl_usd: round(pnl),
          pnl_pct: round(pnlPct),
          exit_reason: reason,
        });
        await base44.entities.Alert.create({
          symbol: t.symbol,
          title: `${t.symbol} closed ${pnl >= 0 ? "in profit" : "at a loss"} (${round(pnlPct)}%)`,
          message: `${
            reason === "target"
              ? "Target reached"
              : reason === "trailing"
                ? "Trailing stop hit"
                : reason === "time"
                  ? "Stagnant trade cut after sitting still too long"
                  : "Stop hit"
          } at ${round(exitPrice, 6)}. P&L ${round(pnl)} USD.`,
          kind: reason === "time" ? "bot_close" : reason === "target" ? "target_hit" : "stop_hit",
          severity: pnl >= 0 ? "success" : "danger",
          trade_id: t.id,
        });
        // remember the call: its pattern now carries this result into future scans
        await recordLesson(base44, t, pnlPct, pnl, reason);
      } else {
        if (Object.keys(updates).length) await base44.entities.Trade.update(t.id, updates);
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
          current_price: round(price, 6),
          stop_price: round(stop, 6),
          target_price: target,
          size_usd: size,
          pnl_usd: round(unreal),
          pnl_pct: size ? round((unreal / size) * 100) : 0,
          progress_pct: goal ? round(Math.max(0, Math.min(100, (travelled / goal) * 100))) : 0,
        });
      }
    }

    // ---- look for new entries
    const openCount = openTrades.length - closed.length;
    const maxOpen = Math.max(1, Number(config.max_open_positions) || 8);
    const opened = [];
    const proposed = [];
    let board = { rows: [], scannedCount: 0, universeCount: coins.length, summary: null, medianChange24h: 0, source: "cache" };

    if (!light && config.mode !== "off" && openCount < maxOpen) {
      const watch = asArray(await base44.entities.Watchlist.list({ limit: 60 }));
      board = await scanBoard({
        timeframe: config.timeframe || "1h",
        scope: config.market_cap_scope || "all",
        count: 60,
        dailyTargetPct: Number(config.daily_target_pct) || 2,
        extraSymbols: watch.map((w) => w.symbol),
      });

      const since = new Date(
        Date.now() - (Number(config.cooldown_minutes) || 120) * 60000,
      ).toISOString();
      const recent = asArray(
        await base44.entities.Trade.filter({ closed_at: { $gte: since } }, { limit: 100 }),
      );
      const pending = asArray(
        await base44.entities.Trade.filter({ status: "proposed" }, { limit: 50 }),
      );
      const blocked = new Set([
        ...openTrades.map((t) => t.symbol),
        ...recent.map((t) => t.symbol),
        ...pending.map((t) => t.symbol),
      ]);

      // trading style bends the rules without touching what the user saved:
      // timid waits for stronger setups with less at stake, aggressive
      // accepts more setups and stakes more to reach the daily goal faster
      const style = config.trading_style || "mild";
      const minScore = Math.max(
        40,
        (Number(config.min_score) || 62) + (style === "timid" ? 6 : style === "aggressive" ? -5 : 0),
      );
      const allowShorts = config.allow_shorts !== false;
      const requireTarget = config.require_daily_target !== false;
      const riskPct = Math.min(
        25,
        (Number(config.risk_per_trade_pct) || 4) *
          (style === "timid" ? 0.75 : style === "aggressive" ? 1.4 : 1),
      );
      const slots = maxOpen - openCount;

      // self-teaching: past results per pattern (side x cap tier) nudge scores
      const lessons = await loadLessons(base44);
      const lessonMap = new Map(lessons.map((l) => [l.pattern, l]));

      const candidates = board.rows
        .map((r) => {
          const adj = lessonMap.get(`${r.side}/${r.market_cap_bucket}`)?.adj || 0;
          return adj ? { ...r, score: r.score + adj } : r;
        })
        .filter(
          (r) =>
            !blocked.has(r.symbol) &&
            r.score >= minScore &&
            (allowShorts || r.side === "long") &&
            (!requireTarget || r.meets_daily_target),
        )
        .slice(0, slots);

      for (const r of candidates) {
        const stopDist = Math.abs(r.entry - r.stop);
        if (!(stopDist > 0)) continue;
        const riskUsd = (cash * riskPct) / 100;
        let qty = riskUsd / stopDist;
        let sizeUsd = qty * r.entry;
        const freeSlots = Math.max(1, maxOpen - openCount - opened.length - proposed.length);
        const cap = cash / freeSlots;
        if (sizeUsd > cap) {
          sizeUsd = cap;
          qty = sizeUsd / r.entry;
        }
        if (sizeUsd < 10) continue;

        // real orders: when enabled, a qualifying long is sent to the chosen
        // exchange as a market buy; shorts stay paper and a refused order is
        // alerted rather than silently paper-traded
        let real = null;
        let realSizeUsd = 0;
        if (live.conn && r.side === "long") {
          realSizeUsd =
            config.real_sizing_mode === "fixed"
              ? Math.min(Number(config.fixed_order_usd) || 100, cap)
              : sizeUsd;
          real =
            realSizeUsd >= 10
              ? await placeMarketOrder(live.conn, {
                  symbol: r.symbol,
                  side: "buy",
                  usd: round(realSizeUsd, 2),
                  price: r.entry,
                })
              : { ok: false, message: "The real order size is below the $10 minimum" };
          if (!real.ok) {
            await base44.entities.Alert.create({
              symbol: r.symbol,
              title: `Real order failed on ${r.symbol}`,
              message: `${live.conn.label} said: ${real.message}`,
              kind: "order_failed",
              severity: "danger",
            });
            continue;
          }
        }

        const created = await base44.entities.Trade.create({
          symbol: r.symbol,
          name: r.name,
          image: r.image,
          side: r.side,
          mode: real ? "real" : "paper",
          status: config.mode === "auto" ? "open" : "proposed",
          entry_price: round(real ? real.avg_price || r.entry : r.entry, 6),
          quantity: round(real ? real.filled_qty || realSizeUsd / r.entry : qty, 8),
          size_usd: round(real ? realSizeUsd : sizeUsd),
          stop_price: r.stop,
          target_price: r.target,
          peak_price: r.entry,
          score: r.score,
          pattern: `${r.side}/${r.market_cap_bucket}`,
          exchange: real ? live.conn.exchange : undefined,
          exchange_order_id: real ? real.order_id : undefined,
          rationale: (r.reasons || []).join(" • "),
          opened_at: new Date().toISOString(),
        });

        if (config.mode === "auto") {
          if (!real) cash -= sizeUsd;
          opened.push({
            id: created.id,
            symbol: r.symbol,
            side: r.side,
            entry: r.entry,
            size_usd: round(real ? realSizeUsd : sizeUsd),
            mode: real ? "real" : "paper",
          });
          await base44.entities.Alert.create({
            symbol: r.symbol,
            title: `Bot opened a ${r.side} on ${r.symbol}`,
            message: `Entry ${r.entry}, target ${r.target} (${r.required_move_pct}% move), stop ${r.stop}. Score ${r.score}.${real ? ` Real order placed on ${live.conn.label}.` : ""}`,
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
    }

    // ---- daily goal check
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const todays = asArray(
      await base44.entities.Trade.filter(
        { status: "closed", closed_at: { $gte: dayStart.toISOString() } },
        { limit: 200 },
      ),
    );
    const realizedToday = todays.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);
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
          kind: "daily_goal",
          severity: "success",
        });
      }
    }

    // ---- live (exchange) stats: every real trade, bot-placed or hand-logged
    const realOpen = asArray(
      await base44.entities.Trade.filter({ status: "open", mode: "real" }, { limit: 50 }),
    );
    const livePositions = realOpen.map((t) => {
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
        entry_price: entry,
        current_price: round(price, 6),
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
    const realClosedToday = asArray(
      await base44.entities.Trade.filter(
        { status: "closed", mode: "real", closed_at: { $gte: dayStart.toISOString() } },
        { limit: 200 },
      ),
    );
    const liveRealized = realClosedToday.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);

    // the exchange's own quote-currency balance, refreshed on full cycles only
    let exchangeBalance = null;
    if (live.conn && !light) {
      const acct = await readAccount({
        exchange: live.conn.exchange,
        testnet: live.conn.testnet,
        api_key: live.conn.api_key,
        api_secret: live.conn.api_secret,
        passphrase: live.conn.passphrase || "",
      });
      if (acct.ok) {
        const quote = QUOTE_ASSET[live.conn.exchange] || "USDT";
        const row = (acct.balances || []).find((b) => b.asset === quote);
        exchangeBalance = row ? round(Number(row.total) || 0, 2) : 0;
      }
    }

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
    const anchoredCash = startBalance + realizedTotal - deployedTotal;
    const equity = anchoredCash + exposure + unrealized;

    await base44.entities.BotConfig.update(config.id, {
      cash_balance: round(anchoredCash),
      last_run_at: new Date().toISOString(),
    });

    return Response.json({
      mode: config.mode,
      closed,
      opened,
      proposed,
      positions,
      top: (board.rows || []).slice(0, 12),
      scanned: board.scannedCount,
      universe: board.universeCount,
      summary: board.summary,
      median_change_24h: board.medianChange24h,
      source: board.source,
      cash: round(anchoredCash),
      exposure: round(exposure),
      unrealized: round(unrealized),
      equity: round(equity),
      realized_today: round(realizedToday),
      daily_goal: round(goal),
      goal_hit: goalHit,
      live: {
        enabled: config.real_orders_enabled === true,
        connection: live.conn ? { label: live.conn.label, exchange: live.conn.exchange } : null,
        balance_usd: exchangeBalance,
        open_count: livePositions.length,
        exposure: round(liveExposure),
        unrealized: round(liveUnrealized),
        realized_today: round(liveRealized),
        positions: livePositions,
      },
      open_count: positions.length,
      config,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}