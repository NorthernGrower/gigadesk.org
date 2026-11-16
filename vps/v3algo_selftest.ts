// Self-test for the V3 algorithm port: run with
//   deno run --allow-read vps/v3algo_selftest.ts
// It exercises the same pure functions the bot calls, on synthetic daily bars,
// and exits non-zero on the first failed assertion.

import { atrSeries, closedBars, evaluateV3, v3ExitDue, v3Plan } from "../base44/shared/v3algo.ts";

function assert(ok: boolean, label: string) {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok ${label}`);
}

const DAY = 86400000;
const now = Date.now();
const candles: any[] = [];
let price = 100;
for (let i = 0; i < 120; i++) {
  const o = price;
  const c = i === 119 ? price + 4 : price + 0.05;
  const h = Math.max(o, c) + 0.05;
  const l = Math.min(o, c) - 0.05;
  candles.push({ t: now - (120 - i) * DAY, o, h, l, c, v: 120_000 });
  price = c;
}

// 1. closedBars: a forming bar (t = now) is dropped, a closed one is kept
const withForming = [...candles, { t: now, o: price, h: price + 1, l: price - 1, c: price, v: 1 }];
assert(closedBars(withForming).length === candles.length, "closedBars drops the forming bar");
assert(closedBars(candles).length === candles.length, "closedBars keeps a closed series");

// 2. evaluateV3: the synthetic breakout + formation + liquidity + regime passes
const ev = evaluateV3({ candles, btcAboveSma200: true });
assert(ev.state === "entry", "evaluateV3 returns entry for the synthetic setup");
assert(ev.gates.entry_signal && ev.gates.liquidity && ev.gates.regime && ev.gates.confluence,
  "all four V3 gates pass");
assert(ev.formations.length > 0, "a survivor formation is named");
assert(ev.atr > 0, "ATR is positive");
const atrNow = Number(ev.atr);

// 3. regime gate fails closed
const off = evaluateV3({ candles, btcAboveSma200: false });
assert(off.state === "none" && off.gates.regime === false, "regime gate fails closed");

// 4. liquidity gate
const thin = evaluateV3({ candles, btcAboveSma200: true, minAdvUsd: 1e12 });
assert(thin.state === "none" && thin.gates.liquidity === false, "liquidity floor rejects thin pairs");

// 5. the plan: a 2xATR stop below entry, no target
const plan = v3Plan({ entryPx: 104, atr: atrNow });
assert(plan != null && plan.stop < 104, "v3Plan puts the stop below the entry");
assert(Math.abs((104 - plan!.stop) - 2 * atrNow) < 1e-9, "the stop is exactly 2xATR");
assert(!("target" in plan!), "the plan carries no target");
assert(v3Plan({ entryPx: 1, atr: 5 }) === null, "a stop wider than price is refused");

// 6. exits: stop breach fills at the stop, the horizon closes on time
const stopHit = v3ExitDue({
  trade: { v3_stop: 100, v3_horizon_bars: 30, opened_at: new Date(now - 2 * DAY).toISOString() },
  price: 99,
});
assert(stopHit.exit && stopHit.reason === "stop" && stopHit.price === 100, "stop breach exits at the stop");

const running = v3ExitDue({
  trade: { v3_stop: 100, v3_horizon_bars: 30, opened_at: new Date(now - 2 * DAY).toISOString() },
  price: 120,
});
assert(!running.exit && running.days_held === 2, "a healthy position keeps running");

const timedOut = v3ExitDue({
  trade: { v3_stop: 100, v3_horizon_bars: 30, opened_at: new Date(now - 31 * DAY).toISOString() },
  price: 120,
});
assert(timedOut.exit && timedOut.reason === "time" && timedOut.price === 120, "horizon exits at the live price");

// 7. ATR sanity
const atr = atrSeries(candles);
assert(Number(atr[atr.length - 1]) > 0 && atr[10] === null, "ATR warms up then produces a value");

console.log("all V3 self-tests passed");
