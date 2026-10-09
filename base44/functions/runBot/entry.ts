import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, asArray, round } from "../../shared/market.ts";
import { scanBoard } from "../../shared/scan.ts";

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
};

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const light = body.light === true;

    let config = asArray(await base44.entities.BotConfig.filter({}, { limit: 1 }))[0];
    if (!config) config = await base44.entities.BotConfig.create(DEFAULT_CONFIG);

    const { coins } = await fetchMarkets();
    const priceMap = new Map(coins.map((c) => [c.symbol, c]));

    const openTrades = asArray(
      await base44.entities.Trade.filter({ status: "open", mode: "paper" }, { limit: 50 }),
    );
    let cash = Number(config.cash_balance) || 0;
    const closed = [];
    const positions = [];

    // ---- manage the positions already open
    for (const t of openTrades) {
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

      if (hitTarget || hitStop) {
        const exitPrice = hitTarget ? target : stop;
        const qty = Number(t.quantity) || 0;
        const size = Number(t.size_usd) || 0;
        const pnl = side === "long" ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
        const pnlPct = size ? (pnl / size) * 100 : 0;
        const reason = hitTarget ? "target" : updates.stop_price ? "trailing" : "stop";

        await base44.entities.Trade.update(t.id, {
          ...updates,
          status: "closed",
          exit_price: round(exitPrice, 6),
          pnl_usd: round(pnl),
          pnl_pct: round(pnlPct),
          closed_at: new Date().toISOString(),
          exit_reason: reason,
        });
        cash += size + pnl;
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
                : "Stop hit"
          } at ${round(exitPrice, 6)}. P&L ${round(pnl)} USD.`,
          kind: reason === "target" ? "target_hit" : "stop_hit",
          severity: pnl >= 0 ? "success" : "danger",
          trade_id: t.id,
        });
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

      const minScore = Number(config.min_score) || 62;
      const allowShorts = config.allow_shorts !== false;
      const requireTarget = config.require_daily_target !== false;
      const riskPct = Number(config.risk_per_trade_pct) || 4;
      const slots = maxOpen - openCount;

      const candidates = board.rows
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

        const created = await base44.entities.Trade.create({
          symbol: r.symbol,
          name: r.name,
          image: r.image,
          side: r.side,
          mode: "paper",
          status: config.mode === "auto" ? "open" : "proposed",
          entry_price: r.entry,
          quantity: round(qty, 8),
          size_usd: round(sizeUsd),
          stop_price: r.stop,
          target_price: r.target,
          peak_price: r.entry,
          score: r.score,
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
          });
          await base44.entities.Alert.create({
            symbol: r.symbol,
            title: `Bot opened a ${r.side} on ${r.symbol}`,
            message: `Entry ${r.entry}, target ${r.target} (${r.required_move_pct}% move), stop ${r.stop}. Score ${r.score}.`,
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

    const exposure = positions.reduce((a, p) => a + p.size_usd, 0);
    const unrealized = positions.reduce((a, p) => a + p.pnl_usd, 0);
    const equity = cash + exposure + unrealized;

    await base44.entities.BotConfig.update(config.id, {
      cash_balance: round(cash),
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
      cash: round(cash),
      exposure: round(exposure),
      unrealized: round(unrealized),
      equity: round(equity),
      realized_today: round(realizedToday),
      daily_goal: round(goal),
      goal_hit: goalHit,
      open_count: positions.length,
      config,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}