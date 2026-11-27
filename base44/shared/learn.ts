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

/** The risk a position carries, in percent of its entry: the distance to its
 *  stop. 0 when either side is unknown, so a caller leaves the R multiple
 *  unknown rather than inventing one.
 */
export function riskPctAt(entry, stop) {
  const e = Number(entry) || 0;
  const s = Number(stop) || 0;
  if (!(e > 0) || !(s > 0)) return 0;
  return (Math.abs(e - s) / e) * 100;
}

/** The risk a trade actually carried, read off the row. Prefer the risk it was
 *  opened with (risk_pct): a stop that has trailed up to break-even sits next
 *  to the entry, so dividing by it would report an R that never happened.
 */
export function riskPctOf(trade) {
  if (!trade) return 0;
  const opened = Number(trade.risk_pct) || 0;
  if (opened > 0) return opened;
  return riskPctAt(trade.entry_price, trade.stop_price);
}

/**
 * The best and worst price a position has reached while it was open, carried on
 * from the values already on the trade and seeded from its entry. Null when
 * either side of the comparison is unknowable, so a caller never invents one.
 *
 * Two trades close at the same P&L and can be nothing alike: one ran straight
 * to its target, the other was two stops deep before it turned. Only this pair
 * tells them apart, so both are kept with the trade itself.
 */
export function excursionOf(trade, side, price) {
  const entry = Number(trade?.entry_price) || 0;
  const mark = Number(price) || 0;
  if (!(entry > 0) || !(mark > 0)) return null;
  const long = side !== "short";
  // an unrecorded side starts at the entry: a fresh position has travelled
  // nowhere, and the first mark is what moves it
  const seenMfe = Number(trade?.mfe_price) || 0;
  const seenMae = Number(trade?.mae_price) || 0;
  const mfe = long
    ? Math.max(entry, seenMfe, mark)
    : Math.min(entry, seenMfe > 0 ? seenMfe : entry, mark);
  const mae = long
    ? Math.min(entry, seenMae > 0 ? seenMae : entry, mark)
    : Math.max(entry, seenMae, mark);
  return { mfe, mae };
}

/**
 * The settings a trade was opened under, copied onto the trade itself. Rules
 * move on — a score bar is raised, an engine is switched off, the BTC trend
 * turns — and a closed row without this copy can only be read against today's
 * rules, so every study of the record would really be a study of the current
 * settings. Only the values the bot actually trades by are kept, so the copy
 * stays small on every row.
 */
export function rulesSnapshot({ desk, book = "USD", view = null, btcAbove200d = null }) {
  const v = view || {};
  const num = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
  return {
    desk,
    book,
    score_bar: num(v.score_bar ?? v.min_score),
    risk_per_trade_pct: num(v.risk_per_trade_pct),
    max_open_positions: num(v.max_open_positions),
    max_trade_loss_pct: num(v.max_trade_loss_pct),
    trading_style: v.trading_style || null,
    timeframe: v.timeframe || null,
    v3_algo: v.v3_algo === true,
    v3_exit: v.v3_exit === true,
    v3_profile: v.v3_profile || null,
    harmonics: v.harmonics === true,
    always_take_top: v.always_take_top === true,
    engine_v2: v.engine_v2 !== false,
    champion_engine: v.champion_engine !== false,
    combo_engine: v.combo_engine !== false,
    margin_engine: v.margin_engine === true,
    pyramid: v.pyramid === true,
    // the market the entry was judged in, when the cycle read it
    btc_above_200d: btcAbove200d == null ? null : btcAbove200d === true,
  };
}

/**
 * The two numbers a closed trade keeps for a longer study: the result in units
 * of the risk it actually took (an R multiple, so a target and a stop-out
 * compare across coins and position sizes), and how long it was held — a
 * stop-out after two hours and one after two weeks are different problems.
 * Either is left out rather than guessed when the row cannot say.
 */
export function outcomeFields(trade, pnlPct, closedMs = Date.now()) {
  const riskPct = riskPctOf(trade);
  const openedMs = trade && trade.opened_at ? Date.parse(trade.opened_at) : 0;
  return {
    ...(riskPct > 0 ? { r_multiple: round((Number(pnlPct) || 0) / riskPct, 2) } : {}),
    ...(openedMs > 0 ? { hold_hours: round(Math.max(0, closedMs - openedMs) / 3600000, 1) } : {}),
  };
}

/** Remembers one closed call so future scans can weight the pattern.
 *  Break-even calls carry no signal, so they are left out of the memory.
 *
 *  The R multiple and the hold time travel with it (see outcomeFields), so
 *  the pattern's record reads in risk and in time, not only in percent.
 */
export async function recordLesson(base44, trade, pnlPct, pnlUsd, exitReason, closedMs = Date.now()) {
  if (!trade.pattern || (Number(pnlUsd) || 0) === 0) return null;
  return base44.entities.Lesson.create({
    pattern: trade.pattern,
    symbol: trade.symbol,
    side: trade.side === "short" ? "short" : "long",
    score: Number(trade.score) || 0,
    win: (Number(pnlUsd) || 0) >= 0 ? 1 : 0,
    pnl_pct: round(Number(pnlPct) || 0, 2),
    pnl_usd: round(Number(pnlUsd) || 0),
    ...outcomeFields(trade, pnlPct, closedMs),
    exit_reason: exitReason || "",
  });
}
