// The desk analyst's arithmetic. Pure and dependency-free on purpose: it runs
// under Deno without a network, a model or a database, so it can be unit-tested
// in vps/analyst_selftest.ts like the other pure modules.
//
// The division of labour is the whole point. This file computes every number.
// The model reads them back and writes prose. Nothing the model writes is
// executed, and the response schema it answers to carries no numeric field, so
// an invented figure can never arrive on screen dressed up as a measurement.

/**
 * What each entry source was measured to do, and where the number came from.
 * Only a source listed here gets a verdict. The rest report their own results
 * and say plainly that there is nothing to compare them against — inventing an
 * expectation for them would be the one thing this module exists to avoid.
 */
export const EXPECTATIONS: Record<string, { label: string; per_trade_pct: number; trades_per_year: number; source: string }> = {
  v3: {
    label: "V3 loose",
    per_trade_pct: 7.44,
    trades_per_year: 52,
    source: "RELAXATION_LADDER.md — loose profile, out of sample, 4 of 6 folds positive",
  },
};

/** Trades a source needs before its verdict is worth reading. Below it the
 *  report still prints the numbers and says they are too few to judge. */
export const MIN_TRADES_FOR_VERDICT = 20;

/** The entry sources a desk can produce, in the order the report lists them. */
export const SOURCES = ["v3", "gated", "top_pick"];

const round = (n: any, d = 2) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;

/** Which entry source a closed trade came from, defaulting to the scored gates. */
export function sourceOf(trade: any): string {
  const src = String((trade && trade.entry_source) || "");
  return src === "v3" || src === "top_pick" ? src : "gated";
}

function medianOf(values: number[]) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function groupStats(trades: any[]) {
  const pcts = trades.map((t) => Number(t.pnl_pct) || 0);
  // a break-even close is not a win: the memory in learn.ts counts it as one,
  // but a briefing that flatters the desk is worse than no briefing
  const wins = trades.filter((t) => (Number(t.pnl_usd) || 0) > 0).length;
  return {
    trades: trades.length,
    mean_pct: trades.length ? round(pcts.reduce((a, v) => a + v, 0) / trades.length) : 0,
    median_pct: round(medianOf(pcts)),
    win_rate: trades.length ? Math.round((wins / trades.length) * 100) : 0,
    best_pct: trades.length ? round(Math.max(...pcts)) : 0,
    worst_pct: trades.length ? round(Math.min(...pcts)) : 0,
    booked_usd: round(trades.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0)),
  };
}

/**
 * How each source is doing against what it was measured to do. This is the
 * decay monitor: a live desk that drifts away from its backtest is the one
 * thing a paper run can catch early, and it is the only figure here that is
 * allowed to carry a verdict.
 */
export function decayReport(trades: any[], options: any = {}) {
  const rows = Array.isArray(trades) ? trades : [];
  const minTrades =
    Number(options.minTrades) > 0 ? Math.round(Number(options.minTrades)) : MIN_TRADES_FOR_VERDICT;
  const groups = SOURCES.map((source) => {
    const own = rows.filter((t) => sourceOf(t) === source);
    const stats = groupStats(own);
    const expectation = EXPECTATIONS[source] || null;
    let verdict = "unmeasured";
    if (expectation) {
      if (stats.trades < minTrades) verdict = "too_few";
      else if (stats.mean_pct <= 0) verdict = "losing";
      else if (stats.mean_pct < expectation.per_trade_pct * 0.5) verdict = "below_backtest";
      else verdict = "in_line";
    }
    return { source, label: (expectation && expectation.label) || source, ...stats, expectation, verdict };
  });
  // the desk's headline state comes from a measured source that actually has
  // results behind it. A measured source with no trades yet can not describe
  // the desk — it would read as "too few trades" for a desk that never ran
  // that engine at all — so the desk says it is unmeasured instead
  const measured = groups.filter((g) => g.expectation && g.trades > 0);
  const rank: Record<string, number> = { losing: 0, below_backtest: 1, too_few: 2, in_line: 3 };
  const worst = measured
    .slice()
    .sort((a, b) => (rank[a.verdict] ?? 4) - (rank[b.verdict] ?? 4))[0];
  return {
    groups,
    state: worst ? worst.verdict : "unmeasured",
    min_trades: minTrades,
    as_of: new Date().toISOString(),
  };
}

/**
 * Everything the analyst is allowed to know about one desk: its own rules, its
 * open positions, its recent closes and its booked totals. Whitelisted field by
 * field — the desk config carries far more than a note needs, and none of it is
 * sent.
 */
export function deskDigest(input: any) {
  const { desk, closed, open, config } = input || {};
  const rows = Array.isArray(closed) ? closed : [];
  const openRows = Array.isArray(open) ? open : [];
  const nowMs = Number.isFinite(Number(input && input.nowMs)) ? Number(input.nowMs) : Date.now();
  const recent = [...rows].sort((a, b) =>
    String((b && b.closed_at) || "").localeCompare(String((a && a.closed_at) || "")),
  );
  const lastDay = recent.filter(
    (t) => t && t.closed_at && nowMs - Date.parse(t.closed_at) < 86400000,
  );

  const fact = (t: any) => ({
    symbol: (t && t.symbol) || "",
    side: t && t.side === "short" ? "short" : "long",
    source: sourceOf(t),
    pnl_pct: round(Number(t && t.pnl_pct) || 0),
    pnl_usd: round(Number(t && t.pnl_usd) || 0),
    exit_reason: (t && t.exit_reason) || "",
    score: Number(t && t.score) || 0,
    closed_at: (t && t.closed_at) || null,
  });
  const position = (t: any) => ({
    symbol: (t && t.symbol) || "",
    side: t && t.side === "short" ? "short" : "long",
    source: sourceOf(t),
    size_usd: round(Number(t && t.size_usd) || 0),
    days_open: t && t.opened_at ? Math.max(0, Math.floor((nowMs - Date.parse(t.opened_at)) / 86400000)) : 0,
    stop_price: Number(t && t.stop_price) || 0,
    v3: !!(t && t.v3_algo === true),
    horizon_bars: Number(t && t.v3_horizon_bars) || null,
  });
  const cfg = config || {};

  return {
    desk: desk === "live" ? "live" : "paper",
    as_of: new Date(nowMs).toISOString(),
    counts: { closed_180d: rows.length, closed_24h: lastDay.length, open: openRows.length },
    booked: {
      usd_24h: round(lastDay.reduce((a, t) => a + (Number(t && t.pnl_usd) || 0), 0)),
      usd_180d: round(rows.reduce((a, t) => a + (Number(t && t.pnl_usd) || 0), 0)),
    },
    recent_closes: recent.slice(0, 5).map(fact),
    open_positions: openRows.slice(0, 8).map(position),
    rules: {
      mode: cfg.mode || "approve",
      v3_algo: cfg.v3_algo === true,
      v3_profile: cfg.v3_profile || "loose",
      always_take_top: cfg.always_take_top === true,
      always_take_count: Number(cfg.always_take_count) || 0,
      score_bar: Number(cfg.score_bar) || 0,
      risk_per_trade_pct: Number(cfg.risk_per_trade_pct) || 0,
      max_open_positions: Number(cfg.max_open_positions) || 0,
      allow_shorts: cfg.allow_shorts !== false,
      trading_style: cfg.trading_style || "mild",
      timeframe: cfg.timeframe || "1h",
    },
  };
}

/**
 * The answer shape. Prose only: no numbers, no levels, no sizes, nothing the
 * page would render as a measurement. If a figure is not in the digest above,
 * the note can not state it.
 */
export const BRIEFING_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    stance: { type: "string", enum: ["stand_aside", "selective", "normal", "caution"] },
    closes: {
      type: "array",
      items: {
        type: "object",
        properties: { symbol: { type: "string" }, note: { type: "string" } },
        required: ["symbol", "note"],
      },
    },
    watch: { type: "array", items: { type: "string" } },
    risks: { type: "string" },
  },
  required: ["headline", "summary", "stance", "closes", "watch", "risks"],
};

/** The one prompt the analyst sends. Kept here so the rules travel with the
 *  schema and a change to either is visible in one place. */
export function briefingPrompt(digest: any, decay: any) {
  return [
    "You are the read-only analyst on one crypto trading desk. You are writing the note the owner reads when they open the desk page.",
    "",
    "Hard rules:",
    "- You cannot place, open, close, size, approve or change anything. Nothing you write is executed. Never imply otherwise.",
    "- Use only the numbers below. Do not calculate, annualise, extrapolate, estimate a price or invent a figure.",
    "- Where a source has no measured expectation, say it is unmeasured. Never imply an edge that was not measured.",
    "- Few trades are not evidence. If the desk's record rests on a handful, say that plainly in the note.",
    "- Never promise or predict a return, and never call a result proven.",
    "",
    "Write:",
    "- headline: under 12 words, on what this desk is actually doing.",
    "- summary: at most 90 words on what the desk did and what it means at its own settings.",
    "- closes: one note of at most 30 words for each recent close listed, saying why it worked or failed, in terms of the recorded exit, side and numbers.",
    "- watch: up to 4 short things worth watching on this desk's own terms.",
    "- risks: the main risk to this desk over the next few days, at most 45 words.",
    "- stance: stand_aside, selective, normal or caution.",
    "",
    "Desk data:",
    JSON.stringify(digest, null, 2),
    "",
    "Results against the backtest that set the expectation:",
    JSON.stringify(decay, null, 2),
  ].join("\n");
}

const text = (value: any, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * Validate and clamp whatever came back. A model answer that is missing its
 * headline and summary is discarded outright — the page shows the numbers and
 * says the prose was unavailable, which beats showing half a note.
 */
export function cleanBriefing(raw: any) {
  if (!raw || typeof raw !== "object") return null;
  const headline = text(raw.headline, 120);
  const summary = text(raw.summary, 700);
  if (!headline && !summary) return null;
  const stance = ["stand_aside", "selective", "normal", "caution"].includes(raw.stance) ? raw.stance : "normal";
  const closes = Array.isArray(raw.closes)
    ? raw.closes
        .slice(0, 6)
        .map((c) => ({
          symbol: text(c && c.symbol, 12).toUpperCase(),
          note: text(c && c.note, 220),
        }))
        .filter((c) => c.symbol && c.note)
    : [];
  const watch = Array.isArray(raw.watch)
    ? raw.watch.map((w) => text(w, 140)).filter(Boolean).slice(0, 4)
    : [];
  return { headline, summary, stance, closes, watch, risks: text(raw.risks, 500) };
}
