// V3 DIRECTION ENGINE — Phase C rebuild: every weight comes from the replay.
//
// The engine composes its read from the indicators the 8-year direction-ranking
// replay KEPT (positive hit-rate edge vs base rate on train AND validation, with
// enough signals), weighted by that measured edge — no vote survives on design
// taste. Provenance: weights generated from vps/output/indicator_ranking.json,
// first full pass 2026-11-14 (harness commit b7a5e89; 8 years of Binance public
// klines; 55-indicator pool; 50/25/25 splits pooled over BTC/ETH/BNB/XRP/SOL).
// The evidence cut cleanly: the old trend/structure/flow votes lost their seats,
// S/R pressure and the mean-reversion cluster carry intraday, and
// three_white_soldiers carries daily.
//
// Owner-required feature: a larger timeframe's read confirms direction for a
// shorter-timeframe setup. Pass opts.timeframe + opts.htfScore (the daily read's
// score) on an intraday timeframe and the confirmation enters as its own weighted
// vote (HTF_WEIGHT) — an additive vote, never a hard filter (the SMA200 gate
// already failed its forward test in the research).
//
// Kept from the original chassis: the ATR-scaled drift band, agreement-discounted
// conviction, and structural invalidation — none of that is contradicted by the
// replay, and the Phase D forward test judges the whole read together.
//
// Pure functions only: no network, no storage, no keys, deterministic.

import { INDICATORS } from "./ranking_indicators.ts";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** Wilder-free simple ATR: mean true range over `period` bars (kept from v1). */
export function atrMean(candles: any[], period = 14): number | null {
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
  const atr = ranges.reduce((a: number, b: number) => a + b, 0) / ranges.length;
  return atr > 0 ? atr : null;
}

// Per-timeframe vote tables from the leaderboard: [indicator name, weight].
// Weights are mean(train, validation) hit-rate edge, rescaled to sum 100 per
// timeframe. On 4h/1h, chassis_location merged into sr_pressure_2atr (identical
// vote series); on 1d, chassis_flow merged into obv_slope_10 for the same reason.
export const WEIGHTS_BY_TF: Record<string, [string, number][]> = {
  "1d": [
    ["three_white_soldiers", 39.7],
    ["hanging_man", 20.0],
    ["bb_squeeze_break", 16.8],
    ["donchian_break_20", 6.1],
    ["keltner_break_20_2atr", 5.3],
    ["bb_breakout_20_2", 4.5],
    ["macd_line_vs_signal", 1.7],
    ["macd_hist_sign", 1.7],
    ["chassis_momentum", 1.4],
    ["obv_slope_10", 1.4],
  ],
  "4h": [
    ["stoch_overbought_meanrev", 27.6],
    ["hanging_man", 21.5],
    ["sr_pressure_2atr", 35.4],
    ["obv_price_divergence", 15.5],
  ],
  "1h": [
    ["stoch_overbought_meanrev", 17.0],
    ["mfi_14_extreme", 13.9],
    ["sr_pressure_2atr", 22.4],
    ["hanging_man", 10.0],
    ["obv_price_divergence", 7.8],
    ["piercing_line", 7.5],
    ["gravestone_doji", 7.4],
    ["matching_high", 6.7],
    ["harami_reversal", 3.9],
    ["shooting_star", 3.3],
  ],
};

const FALLBACK_TF = "1d";
const HTF_WEIGHT = 15; // intraday confirmation share, pre-registered for Phase D
const BY_NAME = new Map(INDICATORS.map((i) => [i.name, i]));

const NEUTRAL = () => ({
  direction: "neutral", score: 0, conviction: 0, drift_band: null,
  invalidation: null, reasons: ["insufficient history"],
  components: {}, agreement: { agree: 0, total: 0 },
});

export function directionRead(candles: any[], opts: any = {}) {
  const tf = WEIGHTS_BY_TF[opts.timeframe] ? opts.timeframe : FALLBACK_TF;
  if (!candles || candles.length < 220) return { timeframe: tf, ...NEUTRAL() };

  const price = candles[candles.length - 1].c;
  const atrVal = atrMean(candles, 14);
  const table = [...WEIGHTS_BY_TF[tf]];
  const hasHtf = tf !== "1d" && Number.isFinite(Number(opts.htfScore));
  if (hasHtf) table.push(["htf_confirmation", HTF_WEIGHT]);
  const norm = 100 + (hasHtf ? HTF_WEIGHT : 0);

  const components: Record<string, number> = {};
  let score = 0;
  for (const [name, w] of table) {
    let vote = 0;
    if (name === "htf_confirmation") {
      const h = Number(opts.htfScore);
      vote = h >= 20 ? 1 : h <= -20 ? -1 : 0;
    } else {
      const ind = BY_NAME.get(name);
      vote = ind ? ind.votes(candles)[candles.length - 1] : 0;
    }
    components[name] = vote;
    score += (w / norm) * vote * 100;
  }
  score = clamp(score, -100, 100);

  // agreement: share of non-zero votes on the dominant side — one loud tool
  // cannot fake a read when the desk disagrees
  const values = Object.values(components);
  const nonzero = values.filter((v) => v !== 0);
  const dominant = sgn(values.reduce((a: number, b: number) => a + b, 0));
  const agree = nonzero.length
    ? nonzero.filter((v) => (v > 0) === (dominant > 0)).length / nonzero.length
    : 0;
  const conviction = clamp(Math.round(Math.abs(score) * (0.5 + 0.5 * agree)), 0, 100);
  const direction = score >= 20 ? "up" : score <= -20 ? "down" : "neutral";

  // probabilistic drift band over 6 bars: diffusion-scaled by ATR, skewed by score
  let drift_band: any = null;
  if (atrVal) {
    const width = 0.7 * atrVal * Math.sqrt(6);
    const expected = (score / 100) * 0.5 * width;
    drift_band = {
      horizon_bars: 6,
      low: r3(price + expected - 0.6 * width),
      high: r3(price + expected + 0.6 * width),
      low_atr: r3((expected - 0.6 * width) / atrVal),
      high_atr: r3((expected + 0.6 * width) / atrVal),
    };
  }

  // structural invalidation: last confirmed swing plus the 0.786 retracement of
  // the current leg — the levels that would falsify the read
  const { ph1, pl1 } = legLevels(candles);
  let invalidation: any = null;
  const fib = Number.isNaN(ph1) || Number.isNaN(pl1) ? null : pl1 + (ph1 - pl1) * 0.786;
  if (direction === "up") {
    const floors = [pl1, fib].filter((v) => v != null && !Number.isNaN(v) && v < price);
    if (floors.length) invalidation = { level: r3(Math.max(...floors)), kind: "swing_low_or_fib_0.786" };
  } else if (direction === "down") {
    const ceilings = [ph1, fib].filter((v) => v != null && !Number.isNaN(v) && v > price);
    if (ceilings.length) invalidation = { level: r3(Math.min(...ceilings)), kind: "swing_high_or_fib_0.786" };
  }

  const reasons = table
    .map(([name]) => [name, components[name]])
    .filter(([, vote]) => vote !== 0)
    .sort((a: any, b: any) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([name, vote]) => `${name} ${vote > 0 ? "up" : "down"}`);

  return {
    timeframe: tf,
    direction, score: r3(score), conviction, drift_band, invalidation,
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, r3(v)])),
    agreement: { agree: Math.round(agree * 100), total: values.length },
    reasons,
  };
}

/** Most recent confirmed swing high and low (2-bar confirmation, causal). */
function legLevels(candles: any[]): { ph1: number; pl1: number } {
  let ph1 = NaN, pl1 = NaN;
  for (let p = 2; p <= candles.length - 3; p++) {
    let isHigh = true, isLow = true;
    for (let w = p - 2; w <= p + 2; w++) {
      if (w === p) continue;
      if (candles[w].h > candles[p].h) isHigh = false;
      if (candles[w].l < candles[p].l) isLow = false;
    }
    if (isHigh) ph1 = candles[p].h;
    if (isLow) pl1 = candles[p].l;
  }
  return { ph1, pl1 };
}

/** The read at every bar from 220 bars on — member series computed once. */
export function directionSeries(candles: any[], opts: any = {}) {
  const tf = WEIGHTS_BY_TF[opts.timeframe] ? opts.timeframe : FALLBACK_TF;
  const table = WEIGHTS_BY_TF[tf];
  const series = table.map(([name]) => BY_NAME.get(name)!.votes(candles));
  const out: any[] = [];
  for (let i = 220; i < candles.length; i++) {
    let score = 0;
    for (let k = 0; k < table.length; k++) score += (table[k][1] / 100) * series[k][i] * 100;
    score = clamp(score, -100, 100);
    const values = table.map((_, k) => series[k][i]);
    const nonzero = values.filter((v) => v !== 0);
    const dominant = sgn(values.reduce((a: number, b: number) => a + b, 0));
    const agree = nonzero.length
      ? nonzero.filter((v) => (v > 0) === (dominant > 0)).length / nonzero.length
      : 0;
    const direction = score >= 20 ? "up" : score <= -20 ? "down" : "neutral";
    out.push({
      bar: candles[i].t ?? i,
      direction, score: r3(score),
      conviction: clamp(Math.round(Math.abs(score) * (0.5 + 0.5 * agree)), 0, 100),
      agreement: { agree: Math.round(agree * 100), total: values.length },
    });
  }
  return out;
}
