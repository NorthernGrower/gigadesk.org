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

/** Remembers one closed call so future scans can weight the pattern. */
export async function recordLesson(base44, trade, pnlPct, pnlUsd, exitReason) {
  if (!trade.pattern) return null;
  return base44.entities.Lesson.create({
    pattern: trade.pattern,
    symbol: trade.symbol,
    side: trade.side === "short" ? "short" : "long",
    score: Number(trade.score) || 0,
    win: (Number(pnlUsd) || 0) >= 0 ? 1 : 0,
    pnl_pct: round(Number(pnlPct) || 0, 2),
    pnl_usd: round(Number(pnlUsd) || 0),
    exit_reason: exitReason || "",
  });
}