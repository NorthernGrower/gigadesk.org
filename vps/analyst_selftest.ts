// Self-test for the desk analyst's pure functions: run with
//   deno run --allow-read vps/analyst_selftest.ts
// It covers the numbers the panel shows, the market context beside the desk and
// the clamping around the model's answer, and exits non-zero on the first failed
// assertion.

import {
  EXPECTATIONS,
  MIN_TRADES_FOR_VERDICT,
  briefingPrompt,
  btcRegime,
  cleanBriefing,
  decayReport,
  deskDigest,
  liveSetups,
  marketContext,
  recentAlerts,
  sourceOf,
} from "../base44/shared/analyst.ts";

function assert(ok: boolean, label: string) {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok ${label}`);
}

const DAY = 86400000;
const NOW = Date.now();

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
  closed_at: new Date(NOW - 3600000).toISOString(),
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

// 3c. top picks are never judged against a backtest: no expectation, no verdict
const picks = decayReport(Array.from({ length: 40 }, () => trade({ entry_source: "top_pick" })));
const pickRow = picks.groups.find((g) => g.source === "top_pick")!;
assert(pickRow.expectation === null && pickRow.verdict === "none", "top picks carry no expectation or verdict");
assert(!("top_pick" in EXPECTATIONS), "no backtest expectation is defined for top picks");

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
      opened_at: new Date(NOW - 3 * DAY).toISOString(),
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
    trade({ symbol: "OLD", pnl_usd: 10, closed_at: new Date(NOW - 5 * DAY).toISOString() }),
    trade({ symbol: "NEW", pnl_usd: 20, closed_at: new Date(NOW - 60000).toISOString() }),
  ],
  open: [],
  config: {},
});
assert(ordered.recent_closes[0].symbol === "NEW", "the newest close is listed first");
assert(ordered.booked.usd_24h === 20 && ordered.booked.usd_180d === 30, "booked totals split by window");

// 8. BTC's tape from daily candles: a rising series sits above its 200-day average
const candles = (n: number, start: number) =>
  Array.from({ length: n }, (_, i) => {
    const c = start + i;
    return { t: NOW - (n - i) * DAY, o: c, h: c + 1, l: c - 1, c, v: 1000 };
  });
const tape = btcRegime(candles(250, 100))!;
assert(tape.above_200d === true, "BTC above its 200-day average reads true");
assert(tape.change_24h_pct! > 0, "a rising last day reads as a positive move");
assert(btcRegime(candles(50, 100))!.above_200d === null, "too little history leaves the average unread");
assert(btcRegime(null) === null, "missing candles read as no tape");

// 9. scanner setups: one row per coin, best score first, last day only
const setups = liveSetups(
  [
    { symbol: "SOL", side: "long", score: 80, grade: "A", price: 100, detected_at: new Date(NOW).toISOString(),
      indicators: { ema20: 100, atr: 2, rsi: 50 } },
    { symbol: "SOL", side: "long", score: 70, grade: "B", price: 100, detected_at: new Date(NOW).toISOString(),
      indicators: { ema20: 100, atr: 2, rsi: 50 } },
    { symbol: "ETH", side: "long", score: 65, grade: "B", price: 110, detected_at: new Date(NOW).toISOString(),
      indicators: { ema20: 100, atr: 2, rsi: 50 } },
    { symbol: "DOGE", side: "long", score: 99, grade: "A", price: 1, detected_at: new Date(NOW - 2 * DAY).toISOString(),
      indicators: {} },
  ],
  70,
  NOW,
);
assert(setups.length === 2, "one row per coin, and yesterday's setups drop out");
assert(setups[0].symbol === "SOL" && setups[0].score === 80, "the best score for a coin is kept");
assert(setups[0].entry_ready === true && setups[0].clears_bar === true, "a near-mean coin clearing the bar reads ready");
assert(setups[1].entry_ready === false && setups[1].clears_bar === false, "a stretched coin under the bar reads neither");
assert(!setups.some((s) => s.symbol === "DOGE"), "a stale setup is not shown");

// 10. alerts: this desk only, last day only
const alerts = recentAlerts(
  [
    { kind: "bot_open", symbol: "sol", title: "Paper open", mode: "paper", severity: "info", created_date: new Date(NOW).toISOString() },
    { kind: "bot_open", symbol: "xrp", title: "Live open", mode: "live", severity: "info", created_date: new Date(NOW).toISOString() },
    { kind: "bot_close", symbol: "eth", title: "Old close", mode: "paper", severity: "info", created_date: new Date(NOW - 3 * DAY).toISOString() },
  ],
  "paper",
  NOW,
);
assert(alerts.length === 1 && alerts[0].title === "Paper open", "the paper desk sees only its own recent alerts");
assert(alerts[0].symbol === "SOL", "alert symbols are upper-cased");

// 11. the context: the watchlist carries each coin's score when the scanner has one
const context = marketContext({
  desk: "paper",
  scoreBar: 70,
  nowMs: NOW,
  signals: [
    { symbol: "SOL", side: "long", score: 80, price: 100, detected_at: new Date(NOW).toISOString(),
      indicators: { ema20: 100, atr: 2, rsi: 50 } },
  ],
  alerts: [],
  watchlist: [{ symbol: "sol" }, { symbol: "XRP" }],
  btcDaily: null,
});
assert(context.watchlist[0].symbol === "SOL" && context.watchlist[0].score_now === 80, "a watched coin shows its score");
assert(context.watchlist[1].score_now === null, "a watched coin with no setup shows none");
assert(context.btc === null && context.setups.length === 1, "missing BTC candles leave the context usable");
assert(context.scored === true, "a scored desk labels its setups against the bar");
assert(marketContext({ signals: [], scored: false }).scored === false, "a V3 desk has no score bar to label against");

// 12. the prompt keeps the setups in the read-only frame
const prompt = briefingPrompt({}, {}, context);
assert(prompt.includes("not a call to trade"), "the prompt says setups are not calls to trade");
assert(prompt.includes("Context beside the desk"), "the prompt carries the context");

// 13. the model's answer is clamped, and a useless one is discarded
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
