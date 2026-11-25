// Self-test for the desk analyst's pure functions: run with
//   deno run --allow-read vps/analyst_selftest.ts
// It covers the numbers the panel shows and the clamping around the model's
// answer, and exits non-zero on the first failed assertion.

import {
  EXPECTATIONS,
  MIN_TRADES_FOR_VERDICT,
  cleanBriefing,
  decayReport,
  deskDigest,
  sourceOf,
} from "../base44/shared/analyst.ts";

function assert(ok: boolean, label: string) {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok ${label}`);
}

const trade = (over: Record<string, unknown> = {}) => ({
  symbol: "SOL",
  side: "long",
  mode: "paper",
  status: "closed",
  entry_source: "v3",
  pnl_pct: 8,
  pnl_usd: 80,
  exit_reason: "target",
  score: 70,
  closed_at: new Date(Date.now() - 3600000).toISOString(),
  ...over,
});

// 1. entry source: the default is the scored gates, never v3
assert(sourceOf({ entry_source: "v3" }) === "v3", "an explicit v3 entry is v3");
assert(sourceOf({ entry_source: "top_pick" }) === "top_pick", "a top pick is top_pick");
assert(sourceOf({}) === "gated", "a missing source falls back to gated");
assert(sourceOf({ entry_source: "nonsense" }) === "gated", "an unknown source falls back to gated");

// 2. decay: too few trades is not a verdict
const few = decayReport([trade(), trade()]);
assert(few.groups.find((g) => g.source === "v3")!.verdict === "too_few", "two trades is too few to judge");
assert(MIN_TRADES_FOR_VERDICT === 20, "the verdict floor is 20 trades");

// 3. decay: a source with no measured expectation never gets a verdict
const gated = decayReport(Array.from({ length: 40 }, () => trade({ entry_source: "" })));
const gatedRow = gated.groups.find((g) => g.source === "gated")!;
assert(gatedRow.trades === 40 && gatedRow.verdict === "unmeasured", "gated trades report no verdict");
assert(gatedRow.expectation === null, "gated carries no expectation");
assert(gated.state === "unmeasured", "a desk with nothing measured says so");

// 3b. a measured source with no results does not describe the desk either
const v3Idle = decayReport(Array.from({ length: 40 }, () => trade({ entry_source: "" })));
assert(
  v3Idle.groups.find((g) => g.source === "v3")!.verdict === "too_few",
  "a measured source with no trades reports too few",
);
assert(v3Idle.state === "unmeasured", "the desk does not borrow a verdict from an idle source");

// 4. decay: at the measured expectation the desk is in line; at half it is not
const atExpectation = decayReport(
  Array.from({ length: 24 }, () => trade({ pnl_pct: EXPECTATIONS.v3.per_trade_pct })),
);
assert(atExpectation.groups.find((g) => g.source === "v3")!.verdict === "in_line", "at the backtest it is in line");
assert(atExpectation.state === "in_line", "the measured source sets the desk state");

const half = decayReport(
  Array.from({ length: 24 }, () => trade({ pnl_pct: EXPECTATIONS.v3.per_trade_pct * 0.4 })),
);
assert(half.groups.find((g) => g.source === "v3")!.verdict === "below_backtest", "under half the backtest is below it");

const losing = decayReport(Array.from({ length: 24 }, () => trade({ pnl_pct: -2, pnl_usd: -20 })));
assert(losing.groups.find((g) => g.source === "v3")!.verdict === "losing", "a negative mean is losing");

// 5. a break-even close is not counted as a win
const flat = decayReport([trade({ pnl_usd: 0, pnl_pct: 0 }), trade({ pnl_usd: 0, pnl_pct: 0 })]);
assert(flat.groups.find((g) => g.source === "v3")!.win_rate === 0, "break-even closes are not wins");

// 6. digest: only the desk's own records, and only whitelisted fields
const digest = deskDigest({
  desk: "paper",
  closed: [trade(), trade({ symbol: "ETH", entry_source: "gated", pnl_pct: -3, pnl_usd: -30 })],
  open: [
    {
      symbol: "BTC",
      side: "long",
      mode: "paper",
      size_usd: 500,
      opened_at: new Date(Date.now() - 3 * 86400000).toISOString(),
      stop_price: 90,
      v3_algo: true,
      v3_horizon_bars: 30,
      api_key: "must-not-travel",
    },
  ],
  config: { mode: "auto", v3_algo: true, score_bar: 70, api_key: "must-not-travel" },
});
assert(digest.counts.closed_180d === 2 && digest.counts.open === 1, "digest counts what it was given");
assert(digest.recent_closes.length === 2, "recent closes are listed");
assert(digest.open_positions[0].days_open === 3, "an open position carries its age");
assert(!JSON.stringify(digest).includes("must-not-travel"), "no unlisted field reaches the model");
assert(digest.rules.mode === "auto" && digest.rules.v3_algo === true, "the desk's own rules are carried");

// 7. digest: closes are newest first, and the day's total follows them
const ordered = deskDigest({
  desk: "paper",
  closed: [
    trade({ symbol: "OLD", pnl_usd: 10, closed_at: new Date(Date.now() - 5 * 86400000).toISOString() }),
    trade({ symbol: "NEW", pnl_usd: 20, closed_at: new Date(Date.now() - 60000).toISOString() }),
  ],
  open: [],
  config: {},
});
assert(ordered.recent_closes[0].symbol === "NEW", "the newest close is listed first");
assert(ordered.booked.usd_24h === 20 && ordered.booked.usd_180d === 30, "booked totals split by window");

// 8. the model's answer is clamped, and a useless one is discarded
assert(cleanBriefing(null) === null, "no answer is no note");
assert(cleanBriefing({ headline: "", summary: "" }) === null, "an empty answer is no note");
const clean = cleanBriefing({
  headline: "  Holding two positions  ",
  summary: "x".repeat(2000),
  stance: "panic",
  closes: [{ symbol: "sol", note: "took the target" }, { symbol: "", note: "no symbol" }],
  watch: ["a", "b", "c", "d", "e", "f"],
  risks: "y".repeat(900),
})!;
assert(clean.headline === "Holding two positions", "headline is trimmed");
assert(clean.summary.length === 700 && clean.risks.length === 500, "long fields are capped");
assert(clean.stance === "normal", "an unknown stance falls back to normal");
assert(clean.closes.length === 1 && clean.closes[0].symbol === "SOL", "closes need a symbol and are upper-cased");
assert(clean.watch.length === 4, "at most four watch items survive");

console.log("all desk analyst self-tests passed");
