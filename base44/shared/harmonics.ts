// Harmonic patterns as a score nudge for V3 — nothing more, by the rule the
// desk asked for: a pattern never opens a trade and never blocks one. It is
// read only for a setup V3 has already accepted, from the same daily bars V3
// fetches, and all it does is move that setup's score (+5 when the pattern
// agrees with the long, -5 when it points the other way) and add a line to its
// reasons. On a V3 desk the score gates nothing — it only decides the order
// setups are taken in — so this can reorder candidates and nothing else.
//
// Method, following the reference system's overview (algorush harmonic
// patterns): a percentage-deviation zigzag finds the pivots, each pattern is a
// set of Fibonacci ratio windows on consecutive legs, and the completion point
// D is the Potential Reversal Zone the windows intersect into. A pattern counts
// as spotted when the current price sits in that zone, or within the V3 stop
// distance (2xATR) of it.
//
// The ratio windows are the published ones per pattern. `tolerance` widens each
// window, the way the reference system's "Deviation" setting does — theirs
// defaults to 30%, this is far stricter.

import { closedBars } from "./v3algo.ts";

export const HARMONIC = {
  // the score a matching pattern adds, and the same taken away for one against
  points: 5,
  // a swing must move this much to make a pivot, and sit this many bars from
  // the last one — the reference system's Deviation 5 and Depth 3
  deviationPct: 5,
  depth: 3,
  // how far from the reversal zone the price may be and still count: the V3
  // stop distance, so "spotted" means "at the entry's own risk"
  atrReach: 2,
  // widen every Fibonacci window by this fraction
  tolerance: 0.08,
  // the pattern's latest point must be this recent, in daily bars
  recentBars: 30,
  // how many of the newest pivots to test, so an old shape is never re-read
  maxPivots: 10,
};

type Pivot = { index: number; price: number; high: boolean };

// One PRZ constraint: D sits `ratio` of the leg away from its anchor, on the
// pattern's own side of it. A classic XABCD constrains D twice (from BC and
// from XA); Cypher constrains it from XC, Shark from XA, 5-0 from BC alone.
type Leg = { anchor: "A" | "C"; leg: "BC" | "XA" | "XC"; window: [number, number] };

type Pattern = { name: string; ab: [number, number]; bc: [number, number]; prz: Leg[] };

// The published ratio windows, in the order they win when two patterns fit the
// same pivots equally well.
const PATTERNS: Pattern[] = [
  // Gartley: B 0.618 of XA, C 0.382-0.886 of AB, D 1.13-1.618 of BC at 0.786 of XA
  { name: "Gartley", ab: [0.55, 0.68], bc: [0.382, 0.886], prz: [{ anchor: "C", leg: "BC", window: [1.13, 1.618] }, { anchor: "A", leg: "XA", window: [0.74, 0.83] }] },
  // Bat: B 0.382-0.5 of XA, D 1.618-2.618 of BC at 0.886 of XA
  { name: "Bat", ab: [0.36, 0.55], bc: [0.382, 0.886], prz: [{ anchor: "C", leg: "BC", window: [1.618, 2.618] }, { anchor: "A", leg: "XA", window: [0.84, 0.93] }] },
  // Butterfly: B 0.786 of XA, D beyond X at 1.27-1.618 of XA
  { name: "Butterfly", ab: [0.74, 0.83], bc: [0.382, 0.886], prz: [{ anchor: "C", leg: "BC", window: [1.618, 2.618] }, { anchor: "A", leg: "XA", window: [1.2, 1.7] }] },
  // Crab: B 0.382-0.618 of XA, the deep 1.618 of XA completion
  { name: "Crab", ab: [0.36, 0.66], bc: [0.382, 0.886], prz: [{ anchor: "C", leg: "BC", window: [2.24, 3.618] }, { anchor: "A", leg: "XA", window: [1.5, 1.75] }] },
  // Cypher: C beyond A at 1.13-1.618 of AB, D at 0.786 of XC
  { name: "Cypher", ab: [0.36, 0.66], bc: [1.1, 1.7], prz: [{ anchor: "C", leg: "XC", window: [0.75, 0.83] }] },
  // Shark: B beyond A at 1.13-1.618 of XA, D back at X (0.886-1.13 of XA)
  { name: "Shark", ab: [1.1, 1.7], bc: [1.5, 2.3], prz: [{ anchor: "A", leg: "XA", window: [0.86, 1.15] }] },
  // 5-0: B a 1.618-2.24 extension of XA, D the shallow half-retracement of BC
  { name: "5-0", ab: [1.55, 2.3], bc: [0.32, 0.68], prz: [{ anchor: "C", leg: "BC", window: [0.32, 0.68] }] },
];

export type HarmonicHit = {
  name: string;
  direction: "bullish" | "bearish";
  // the completion point: the middle of the reversal zone
  d: number;
  prz: [number, number];
  // how far the price was from the zone, in ATR
  atr_distance: number;
  // the bar the pattern's latest point printed on
  bar_time: number;
};

const num = (value: any, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const within = (value: number, window: [number, number], tolerance: number) =>
  value >= window[0] * (1 - tolerance) && value <= window[1] * (1 + tolerance);

/**
 * The pivots a percentage-deviation zigzag finds: alternating highs and lows,
 * each leg at least `deviationPct` from the last pivot, never two pivots closer
 * together than `depth` bars.
 */
export function zigzagPivots(bars: any[]): Pivot[] {
  const out: Pivot[] = [];
  const dev = HARMONIC.deviationPct / 100;
  if (!Array.isArray(bars) || bars.length < 3) return out;
  const push = (pivot: Pivot) => {
    const prev = out[out.length - 1];
    if (prev && pivot.high === prev.high) {
      // the same side twice: the more extreme one is the real pivot
      if (pivot.high ? pivot.price > prev.price : pivot.price < prev.price) out[out.length - 1] = pivot;
      return;
    }
    if (prev && Math.abs(pivot.index - prev.index) < HARMONIC.depth) return;
    out.push(pivot);
  };
  let dir: 0 | 1 | -1 = 0;
  let high = { index: 0, price: num(bars[0].h) };
  let low = { index: 0, price: num(bars[0].l) };
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    const h = num(bar.h);
    const l = num(bar.l);
    if (h > high.price) high = { index: i, price: h };
    if (l > 0 && (low.price <= 0 || l < low.price)) low = { index: i, price: l };
    const highBroken = high.price > 0 && l > 0 && l <= high.price * (1 - dev);
    const lowBroken = low.price > 0 && h > 0 && h >= low.price * (1 + dev);
    if (dir === 0) {
      if (highBroken && !lowBroken) {
        push({ index: high.index, price: high.price, high: true });
        dir = -1;
        low = { index: i, price: l };
      } else if (lowBroken) {
        push({ index: low.index, price: low.price, high: false });
        dir = 1;
        high = { index: i, price: h };
      }
    } else if (dir === 1) {
      if (highBroken) {
        push({ index: high.index, price: high.price, high: true });
        dir = -1;
        low = { index: i, price: l };
      }
    } else if (lowBroken) {
      push({ index: low.index, price: low.price, high: false });
      dir = 1;
      high = { index: i, price: h };
    }
  }
  return out;
}

/** The interval D may sit in, from one ratio window on one leg. */
function zoneFor(
  point: Pivot,
  anchor: Pivot,
  direction: "bullish" | "bearish",
  window: [number, number],
  tolerance: number,
): [number, number] | null {
  const leg = Math.abs(point.price - anchor.price);
  if (!(leg > 0)) return null;
  const a = window[0] * (1 - tolerance);
  const b = window[1] * (1 + tolerance);
  // bullish: D sits below the anchor, a buy zone; bearish: above it
  const one = direction === "bullish" ? anchor.price - a * leg : anchor.price + a * leg;
  const two = direction === "bullish" ? anchor.price - b * leg : anchor.price + b * leg;
  return [Math.min(one, two), Math.max(one, two)];
}

/** Where the zones overlap, or null when the ratios cannot all hold. */
function overlap(zones: [number, number][]): [number, number] | null {
  let lo = -Infinity;
  let hi = Infinity;
  for (const [a, b] of zones) {
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
  }
  return lo <= hi ? [lo, hi] : null;
}

const distanceTo = (price: number, zone: [number, number]) =>
  price < zone[0] ? zone[0] - price : price > zone[1] ? price - zone[1] : 0;

/**
 * The harmonic pattern the price is sitting on, or null. `atr` is the daily ATR
 * V3 already computed, so "at the price" is measured in the V3 stop distance.
 */
export function detectHarmonic({ candles, atr }: { candles: any[]; atr: number }): HarmonicHit | null {
  const bars = closedBars(Array.isArray(candles) ? candles : []);
  const lastAtr = num(atr);
  if (!(lastAtr > 0) || bars.length < 40) return null;
  const price = num(bars[bars.length - 1].c);
  if (!(price > 0)) return null;
  const reach = HARMONIC.atrReach * lastAtr;
  const tolerance = HARMONIC.tolerance;
  const pivots = zigzagPivots(bars);
  if (pivots.length < 5) return null;
  const newest = pivots.length - 1;
  const oldest = Math.max(0, newest - HARMONIC.maxPivots);

  let best: HarmonicHit | null = null;
  const consider = (hit: HarmonicHit) => {
    if (!best || hit.atr_distance < best.atr_distance) best = hit;
  };

  // ---- the XABCD family (Gartley, Bat, Butterfly, Crab, Cypher, Shark, 5-0):
  // X, A, B, C fixed, D projected from the pattern's ratio windows
  for (let start = oldest; start + 3 <= newest; start += 1) {
    const [X, A, B, C] = pivots.slice(start, start + 4);
    if (C.index < bars.length - HARMONIC.recentBars) continue;
    const bullish = !X.high && A.high && !B.high && C.high;
    const bearish = X.high && !A.high && B.high && !C.high;
    if (!bullish && !bearish) continue;
    const direction: HarmonicHit["direction"] = bullish ? "bullish" : "bearish";
    const xa = Math.abs(A.price - X.price);
    const ab = Math.abs(B.price - A.price);
    const bc = Math.abs(C.price - B.price);
    if (!(xa > 0) || !(ab > 0) || !(bc > 0)) continue;
    for (const pattern of PATTERNS) {
      if (!within(ab / xa, pattern.ab, tolerance)) continue;
      if (!within(bc / ab, pattern.bc, tolerance)) continue;
      const zones: [number, number][] = [];
      for (const leg of pattern.prz) {
        const zone =
          leg.leg === "BC"
            ? zoneFor(B, C, direction, leg.window, tolerance)
            : leg.leg === "XA"
              ? zoneFor(X, A, direction, leg.window, tolerance)
              : zoneFor(X, C, direction, leg.window, tolerance);
        if (zone) zones.push(zone);
      }
      if (!zones.length) continue;
      const prz = overlap(zones);
      if (!prz) continue;
      const distance = distanceTo(price, prz);
      if (distance > reach) continue;
      consider({
        name: pattern.name,
        direction,
        d: (prz[0] + prz[1]) / 2,
        prz,
        atr_distance: distance / lastAtr,
        bar_time: num(bars[C.index] && bars[C.index].t),
      });
    }
  }

  // ---- Three Drives: six pivots, each drive a 1.27-1.618 extension of the one
  // before it with a 0.618-0.786 retracement between them; the third drive's
  // end is the reversal
  for (let start = oldest; start + 5 <= newest; start += 1) {
    const p = pivots.slice(start, start + 6);
    const end = p[5];
    if (end.index < bars.length - HARMONIC.recentBars) continue;
    if (!p.every((pivot, i) => i === 0 || pivot.high !== p[i - 1].high)) continue;
    const d1 = Math.abs(p[1].price - p[0].price);
    const r1 = Math.abs(p[2].price - p[1].price);
    const d2 = Math.abs(p[3].price - p[2].price);
    const r2 = Math.abs(p[4].price - p[3].price);
    const d3 = Math.abs(p[5].price - p[4].price);
    if (!(d1 > 0) || !(d2 > 0) || !(d3 > 0)) continue;
    if (!within(d2 / d1, [1.27, 1.618], tolerance)) continue;
    if (!within(d3 / d2, [1.27, 1.618], tolerance)) continue;
    if (!within(r1 / d1, [0.55, 0.83], tolerance)) continue;
    if (!within(r2 / d2, [0.55, 0.83], tolerance)) continue;
    // three drives up end at a high: that reversal is a sell zone, and down at a low
    const direction: HarmonicHit["direction"] = end.high ? "bearish" : "bullish";
    const band = lastAtr * 0.25;
    const zone: [number, number] = end.high
      ? [end.price, end.price + band]
      : [end.price - band, end.price];
    const distance = distanceTo(price, zone);
    if (distance > reach) continue;
    consider({
      name: "Three Drives",
      direction,
      d: end.price,
      prz: zone,
      atr_distance: distance / lastAtr,
      bar_time: num(bars[end.index] && bars[end.index].t),
    });
  }

  return best;
}
