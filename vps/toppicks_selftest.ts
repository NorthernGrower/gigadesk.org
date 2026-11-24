// Self-test for the always-take top-picks selection: run with
//   deno run vps/toppicks_selftest.ts
// Pure function, synthetic rows, non-zero exit on the first failed assertion.

import { entryReady, pickTopPicks } from "../base44/shared/topPicks.ts";

function assert(ok: boolean, label: string) {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok ${label}`);
}

const row = (symbol: string, score: number, extra: any = {}) => ({
  symbol,
  score,
  entry: 100,
  stop: 95,
  side: "long",
  ...extra,
});

const rows = [
  row("A", 55),
  row("B", 92),
  row("C", 71),
  row("D", 88),
  row("E", 60),
  row("F", 80),
];

// takes the highest scores, in order
const top3 = pickTopPicks(rows, { blocked: new Set(), openSymbols: new Set(), count: 3 });
assert(top3.length === 3, "three picks returned");
assert(top3[0].symbol === "B" && top3[1].symbol === "D" && top3[2].symbol === "F", "highest scores first");
assert(top3.every((r: any) => r.top_pick === true), "every pick is marked");

// blocked and open symbols are skipped
const blocked = pickTopPicks(rows, {
  blocked: new Set(["B"]),
  openSymbols: new Set(["D"]),
  count: 3,
});
assert(blocked.map((r: any) => r.symbol).join(",") === "F,C,E", "blocked and open symbols are skipped");

// a row without usable levels is skipped
const noLevels = pickTopPicks([row("X", 99, { stop: 100 }), row("Y", 50)], {
  blocked: new Set(),
  openSymbols: new Set(),
  count: 2,
});
assert(noLevels.length === 1 && noLevels[0].symbol === "Y", "a stop on the wrong side is refused");

// shorts are skipped unless the venue can short
const withShort = [row("S", 99, { side: "short" }), row("L", 90)];
assert(pickTopPicks(withShort, { blocked: new Set(), openSymbols: new Set(), count: 2 }).length === 1,
  "a short is skipped when shorts are off");
assert(pickTopPicks(withShort, { blocked: new Set(), openSymbols: new Set(), count: 2, allowShorts: true }).length === 2,
  "a short is kept when shorts are allowed");

// duplicates keep the higher score
const dupes = [row("A", 50), row("A", 90)];
const deduped = pickTopPicks(dupes, { blocked: new Set(), openSymbols: new Set(), count: 5 });
assert(deduped.length === 1 && deduped[0].score === 90, "duplicates collapse to the best row");

// count bounds
assert(pickTopPicks(rows, { blocked: new Set(), openSymbols: new Set(), count: 0 }).length === 0,
  "a zero count returns nothing");
assert(pickTopPicks(rows, { blocked: new Set(), openSymbols: new Set(), count: 99 }).length === 6,
  "the count is capped at ten, and never exceeds the rows available");
assert(pickTopPicks([], { blocked: new Set(), openSymbols: new Set(), count: 5 }).length === 0,
  "no rows is no picks");

// entry timing: near the mean is ready, extended is not
const at = (price: number, ema20: number, atr: number, rsi: number, side = "long") =>
  row("T", 80, { side, price, entry: price, indicators: { ema20, atr, rsi } });

assert(entryReady(at(100, 99.6, 1, 55)), "a long near its 20 EMA is ready");
assert(!entryReady(at(104, 100, 2, 60)), "a long two ATR above its 20 EMA waits");
assert(entryReady(at(100, 99.6, 1, 74)), "RSI below 75 does not block a long");
assert(!entryReady(at(100, 100, 1, 78)), "RSI at 78 waits for a long");
assert(entryReady(at(96, 100, 2, 45, "short")), "a short near its 20 EMA is ready");
assert(!entryReady(at(92, 100, 2, 45, "short")), "a short four ATR below its 20 EMA waits");
assert(!entryReady(at(100, 100, 1, 22, "short")), "RSI at 22 waits for a short");
assert(entryReady(row("N", 70)), "a row without indicators is not blocked");

const extended = [row("H", 99, { price: 110, entry: 110, indicators: { ema20: 100, atr: 2, rsi: 60 } }), row("K", 70)];
const timed = pickTopPicks(extended, { blocked: new Set(), openSymbols: new Set(), count: 2, requireEntry: true });
assert(timed.length === 1 && timed[0].symbol === "K", "requireEntry skips the extended pick");
assert(pickTopPicks(extended, { blocked: new Set(), openSymbols: new Set(), count: 2 }).length === 2,
  "without requireEntry both rows are taken");

console.log("top-picks selftest passed");
