// V3 DIRECTION ENGINE — less rigid by design.
//
// V2's rigidity, precisely: a fixed R-multiple target (2R/3R/6R), binary
// verdicts at hard score cut-offs, and all-or-nothing gates (ADX under X →
// veto). V3 replaces the "how far must price go" question with the one the
// user actually asked: *where is price moving, and how sure are we* —
// a continuous direction/conviction read with a probabilistic drift band and
// a structural invalidation level. No fixed percentage appears anywhere:
// every distance is ATR- or structure-scaled, so the read adapts to the
// market's own volatility.
//
// The candlestick votes ingest the five patterns the GigaDesk research
// programme measured as consistent on both in-sample segments and out of
// sample (three_white_soldiers, three_outside_up bullish; gravestone_doji,
// hanging_man, matching_high bearish) — ported from
// Gigadesk-/research/scripts/strike_candlesticks.py. They are the only
// patterns with surviving evidence; everything else stays out.
//
// Candle shape expected: {o, h, l, c} as used elsewhere in this app
// (cf. breakoutAge reading candles[i].c).
//
// Pure functions only: no network, no storage, deterministic. A
// directionRead on a candle slice returns the read as of that bar; a future
// research port can validate the weights against the 8-year history before
// this engine drives any trading decision.

import { pivots, ema, rsi, macd, obv } from "./indicators.ts";
import { elliottRead, zoneRead } from "./confluence.ts";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Wilder-free simple ATR: mean true range over `period` bars. */
export function atrMean(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const ranges = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const prev = candles[i - 1].c;
    ranges.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - prev),
      Math.abs(candles[i].l - prev),
    ));
  }
  const atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  return atr > 0 ? atr : null;
}

// ---- component votes, each in [-1, +1] -------------------------------------

/** Trend persistence: EMA stack alignment plus the fast EMA slope in ATRs. */
function trendVote(candles, atrVal) {
  const closes = candles.map((c) => c.c);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const i = closes.length - 1;
  if (e9[i] == null || e21[i] == null || e50[i] == null) return 0;
  let vote = 0;
  vote += e9[i] > e21[i] ? 0.5 : -0.5;
  vote += e21[i] > e50[i] ? 0.5 : -0.5;
  if (atrVal && i >= 3 && e21[i - 3] != null) {
    // slope over 3 bars, expressed in ATRs, clamped — the graded part
    vote += clamp((e21[i] - e21[i - 3]) / (3 * atrVal), -1, 1) * 0.5;
  }
  return clamp(vote / 1.5, -1, 1);
}

/** Structure: the probabilistic Elliott read from the swing sequence. */
function structureVote(pivotList, dir) {
  const read = elliottRead(pivotList, dir);
  if (read.scenario === "impulse") return 0.8;
  if (read.scenario === "impulse_late") return 0.3;
  if (read.scenario === "corrective") return -0.4;
  return 0;
}

/** Momentum persistence: RSI position, MACD histogram, stochastic pair. */
function momentumVote(candles) {
  const closes = candles.map((c) => c.c);
  const r = rsi(closes, 14);
  const { histogram } = macd(closes);
  const i = closes.length - 1;
  let votes = [];
  if (r[i] != null) votes.push(clamp((r[i] - 50) / 30, -1, 1));
  if (histogram && histogram[i] != null) {
    const scale = closes[i] * 0.002 || 1;
    votes.push(clamp(histogram[i] / scale, -1, 1));
  }
  // drop the stochastic pair: the graded trend/momentum reads already carry
  // the same information, and the V2 binary version was one of the rigid
  // gates this engine replaces
  if (!votes.length) return 0;
  return clamp(votes.reduce((a, b) => a + b, 0) / votes.length, -1, 1);
}

/** Volume-weighted flow: OBV drift over 10 bars in volume units. */
function flowVote(candles) {
  const o = obv(candles);
  const i = o.length - 1;
  if (i < 10) return 0;
  const avgVolume = candles.slice(-10).reduce((a, c) => a + (c.v || 0), 0) / 10;
  if (!avgVolume) return 0;
  return clamp((o[i] - o[i - 10]) / (avgVolume * 10), -1, 1);
}

/** Location pressure: sitting on strong support pushes up, resistance down. */
function locationVote(pivotList, price) {
  const zones = zoneRead(pivotList, price);
  if (zones.at_support && zones.at_resistance) return 0; // squeeze: no read
  if (zones.at_support) return 0.6;
  if (zones.at_resistance) return -0.6;
  const distances = [];
  if (zones.strong_support) distances.push(1 - (price - zones.strong_support) / price);
  if (zones.strong_resistance) distances.push(-1 + (zones.strong_resistance - price) / price);
  if (!distances.length) return 0;
  return clamp(distances.reduce((a, b) => a + b, 0) / distances.length, -0.3, 0.3);
}

// ---- the five research-kept candlestick patterns ----------------------------
// Ported from Gigadesk-/research/scripts/strike_candlesticks.py; thresholds
// identical so the measured edges apply to these detectors one-to-one.

const DOJI_BODY = 0.1;

function shape(bar) {
  const range = bar.h - bar.l;
  if (range <= 0) return null;
  const body = Math.abs(bar.c - bar.o);
  return {
    range, body, body_frac: body / range,
    upper_frac: (bar.h - Math.max(bar.o, bar.c)) / range,
    lower_frac: (Math.min(bar.o, bar.c) - bar.l) / range,
    bullish: bar.c > bar.o,
  };
}

function threeWhiteSoldiers(candles, i) {
  if (i < 2) return false;
  const s = [shape(candles[i - 2]), shape(candles[i - 1]), shape(candles[i])];
  if (s.some((x) => x == null)) return false;
  return s.every((x) => x.bullish && x.body_frac >= 0.5)
    && candles[i].c > candles[i - 1].c && candles[i - 1].c > candles[i - 2].c;
}

function threeOutsideUp(candles, i) {
  if (i < 2) return false;
  const first = shape(candles[i - 2]);
  const second = shape(candles[i - 1]);
  const third = shape(candles[i]);
  if (!first || !second || !third) return false;
  if (first.bullish || !second.bullish || !third.bullish) return false;
  const engulfed = second.o <= first.c && second.c >= first.o;
  return engulfed && second.body >= 1.3 * first.body && third.c > second.c;
}

function gravestoneDoji(candles, i) {
  if (i < 1) return false;
  const s = shape(candles[i]);
  return !!s && s.body_frac <= DOJI_BODY && s.upper_frac >= 0.6 && s.lower_frac <= 0.1;
}

function hangingMan(candles, i, ema50Value) {
  if (i < 1 || ema50Value == null) return false;
  const s = shape(candles[i]);
  return !!s && s.body_frac <= 0.25 && s.lower_frac >= 0.5
    && s.upper_frac <= 0.1 && s.c > ema50Value; // after a rally
}

function matchingHigh(candles, i) {
  if (i < 1) return false;
  const a = candles[i - 1].c;
  const b = candles[i].c;
  return Math.abs(b - a) <= 0.001 * a && b >= a;
}

/** Pattern vote: the five research-kept patterns as ±boosts. */
function patternVote(candles, ema50Series) {
  const i = candles.length - 1;
  const ema50Value = ema50Series ? ema50Series[i] : null;
  let vote = 0;
  if (threeWhiteSoldiers(candles, i)) vote += 1;
  if (threeOutsideUp(candles, i)) vote += 1;
  if (gravestoneDoji(candles, i)) vote -= 1;
  if (hangingMan(candles, i, ema50Value)) vote -= 1;
  if (matchingHigh(candles, i)) vote -= 1;
  return clamp(vote, -1, 1);
}

// ---- the engine -------------------------------------------------------------

const WEIGHTS = {
  trend: 0.28,
  structure: 0.18,
  momentum: 0.18,
  flow: 0.14,
  location: 0.12,
  pattern: 0.1,
};

/**
 * The V3 read as of the last closed candle: a continuous direction score,
 * a conviction level, a probabilistic drift band in ATR units, and the
 * structural level that would invalidate the read. No fixed percentage
 * appears anywhere — every distance is ATR- or structure-scaled.
 */
export function directionRead(candles, opts = {}) {
  const horizon = opts.horizon_bars || 6;
  const minHistory = opts.min_history || 60;
  if (!candles || candles.length < Math.max(minHistory, 10)) {
    return { direction: "neutral", score: 0, conviction: 0, drift_band: null,
             invalidation: null, reasons: ["insufficient history"],
             components: {}, agreement: { agree: 0, total: 6 } };
  }
  const price = candles[candles.length - 1].c;
  const atrVal = atrMean(candles, 14);
  const closes = candles.map((c) => c.c);
  const pivotList = pivots(candles, 2);
  const ema50Series = ema(closes, 50);

  const components = {
    trend: trendVote(candles, atrVal),
    momentum: momentumVote(candles),
    flow: flowVote(candles),
    location: locationVote(pivotList, price),
    pattern: patternVote(candles, ema50Series),
    // structure blends the swing read for both sides: impulse-up strength
    // minus impulse-down strength, so one signed vote covers both directions
    structure: clamp(structureVote(pivotList, 1) - structureVote(pivotList, -1), -1, 1),
  };

  let score = 0;
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    score += components[name] * weight;
  }
  score = clamp(score * 100, -100, 100);

  // agreement: share of non-zero votes on the dominant side — conviction is
  // discounted when the desks disagree, so one loud tool cannot fake a read
  const values = Object.values(components);
  const nonzero = values.filter((v) => v !== 0);
  const dominant = values.reduce((a, b) => a + b, 0) >= 0 ? 1 : -1;
  const agree = nonzero.length
    ? nonzero.filter((v) => (v > 0) === (dominant > 0)).length / nonzero.length
    : 0;
  const conviction = clamp(Math.abs(score) * (0.5 + 0.5 * agree), 0, 100);
  const direction = score >= 20 ? "up" : score <= -20 ? "down" : "neutral";

  // probabilistic drift band over `horizon` bars: diffusion-scaled by ATR,
  // skewed by the score — a band, never a fixed target
  let drift_band = null;
  if (atrVal) {
    const width = 0.7 * atrVal * Math.sqrt(horizon);
    const expected = (score / 100) * 0.5 * width;
    drift_band = {
      horizon_bars: horizon,
      low: r3(price + expected - 0.6 * width),
      high: r3(price + expected + 0.6 * width),
      low_atr: r3((expected - 0.6 * width) / atrVal),
      high_atr: r3((expected + 0.6 * width) / atrVal),
    };
  }

  // structural invalidation: the level that would falsify the read
  let invalidation = null;
  if (direction === "up") {
    const swings = pivotList.filter((pvt) => pvt.kind === "low" && pvt.price < price);
    const lastSwing = swings.length ? swings[swings.length - 1].price : null;
    const fibFloor = (() => {
      const lows = pivotList.filter((pvt) => pvt.kind === "low");
      const highs = pivotList.filter((pvt) => pvt.kind === "high");
      const legEnd = highs[highs.length - 1];
      const legStart = legEnd ? [...lows].reverse().find((pvt) => pvt.i < legEnd.i) : null;
      if (!legEnd || !legStart) return null;
      return legStart.price + (legEnd.price - legStart.price) * 0.786;
    })();
    const level = [lastSwing, fibFloor].filter((v) => v != null && v < price)
      .sort((a, b) => b - a)[0]; // the highest floor that still protects the read
    if (level != null) invalidation = { level: r3(level), kind: "swing_low_or_fib_0.786" };
  } else if (direction === "down") {
    const swings = pivotList.filter((pvt) => pvt.kind === "high" && pvt.price > price);
    const lastSwing = swings.length ? swings[swings.length - 1].price : null;
    const level = lastSwing != null && lastSwing > price ? lastSwing : null;
    if (level != null) invalidation = { level: r3(level), kind: "swing_high" };
  }

  // reasons: the strongest contributors, for the read's transparency
  const reasons = Object.entries(components)
    .filter(([, vote]) => vote !== 0)
    .sort((a, b) => Math.abs(b[1] * WEIGHTS[b[0]]) - Math.abs(a[1] * WEIGHTS[a[0]]))
    .slice(0, 3)
    .map(([name, vote]) => `${name} ${vote > 0 ? "up" : "down"} (${r3(vote)})`);

  return {
    direction, score: r3(score), conviction: Math.round(conviction),
    drift_band, invalidation,
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, r3(v)])),
    agreement: { agree: Math.round(agree * 100), total: values.length },
    reasons,
  };
}

/** The read at every bar (from `min_history` on) — for research validation. */
export function directionSeries(candles, opts = {}) {
  const out = [];
  const start = opts.min_history || 60;
  for (let i = start; i < candles.length; i++) {
    out.push({ bar: candles[i].t ?? i, ...directionRead(candles.slice(0, i + 1), opts) });
  }
  return out;
}
