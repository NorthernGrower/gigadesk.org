// The bot's memory: every closed bot call is remembered per pattern (side x cap
// tier), and proven win rates nudge future scores up or down.
import { round } from "./market.ts";

/** Per-pattern performance from closed trades; adj is the score bump applied on future scans. */
export async function loadLessons(base44) {
  const agg = await base44.entities.Lesson.aggregate({
    groupBy: "pattern",
    avg: ["win", "pnl_pct"],
    sort: "-count",
    limit: 20,
  });
  return (agg.rows || [])
    .filter((row) => row.pattern)
    .map((row) => {
      const trades = row.count || 0;
      const winRate = Number(row.avg_win) || 0;
      let adj = 0;
      if (trades >= 5) {
        if (winRate >= 0.65) adj = Math.min(8, Math.round((winRate - 0.5) * 20));
        else if (winRate <= 0.35) adj = -Math.min(8, Math.round((0.5 - winRate) * 20));
      }
      return {
        pattern: row.pattern,
        trades,
        win_rate: Math.round(winRate * 100),
        avg_pnl_pct: round(Number(row.avg_pnl_pct) || 0, 2),
        adj,
      };
    });
}

/**
 * The risk a trade actually carried, as a percent of its entry: the distance to
 * the stop it was opened with. 0 when the row has no usable stop, which leaves
 * the R multiple unknown rather than invented.
 */
export function riskPctOf(trade) {
  if (!trade) return 0;
  const entry = Number(trade.entry_price) || 0;
  const stop = Number(trade.stop_price) || 0;
  if (!(entry > 0) || !(stop > 0)) return 0;
  return (Math.abs(entry - stop) / entry) * 100;
}

/** Remembers one closed call so future scans can weight the pattern.
 *  Break-even calls carry no signal, so they are left out of the memory.
 *
 *  Each lesson also keeps the two numbers a longer study needs: the result in
 *  units of the risk the trade actually took (an R multiple, so a target and a
 *  stop-out compare across coins and position sizes), and how long it was held
 *  — a stop-out after two hours and one after two weeks are different problems,
 *  and only the record can tell them apart.
 */
export async function recordLesson(base44, trade, pnlPct, pnlUsd, exitReason, closedMs = Date.now()) {
  if (!trade.pattern || (Number(pnlUsd) || 0) === 0) return null;
  const riskPct = riskPctOf(trade);
  const openedMs = trade.opened_at ? Date.parse(trade.opened_at) : 0;
  return base44.entities.Lesson.create({
    pattern: trade.pattern,
    symbol: trade.symbol,
    side: trade.side === "short" ? "short" : "long",
    score: Number(trade.score) || 0,
    win: (Number(pnlUsd) || 0) >= 0 ? 1 : 0,
    pnl_pct: round(Number(pnlPct) || 0, 2),
    pnl_usd: round(Number(pnlUsd) || 0),
    // unknown when the row carries no stop: left out rather than guessed
    ...(riskPct > 0 ? { r_multiple: round((Number(pnlPct) || 0) / riskPct, 2) } : {}),
    ...(openedMs > 0 ? { hold_hours: round(Math.max(0, closedMs - openedMs) / 3600000, 1) } : {}),
    exit_reason: exitReason || "",
  });
}
