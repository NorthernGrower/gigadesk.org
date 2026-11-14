// vps/ranking_indicators.ts — the wide-pool indicator vote library.
//
// Every indicator reduces a candle series to a per-bar signed vote in {-1, 0, +1},
// computed CAUSALLY: votes[i] may only read candles[0..i]. A vote of 0 means the
// indicator makes no directional claim at that bar, and the replay excludes it from
// that indicator's hit-rate. Event-style tools (candlestick patterns, crosses) vote
// only on the bar the event completes; state-style tools vote on every warm bar.
// Pure functions: no network, no storage, no keys.
//
// The `chassis:*` family are causal replicas of the six direction.ts votes, so the
// engine's own components are ranked by the same ruler as every newcomer.

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }
export interface Indicator { name: string; family: string; votes: (candles: Candle[]) => Int8Array; }

const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---- shared series helpers (all causal) --------------------------------------

function smaSeries(vals: number[], p: number): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= p) sum -= vals[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

function emaSeries(vals: number[], p: number): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (p + 1);
  let prev: number | null = null;
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    if (prev == null) {
      sum += vals[i];
      if (i >= p - 1) { prev = sum / p; out[i] = prev; }
      continue;
    }
    prev = vals[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function emaOfSparse(vals: (number | null)[], p: number): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null);
  const k = 2 / (p + 1);
  let prev: number | null = null;
  let count = 0;
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null) continue;
    if (prev == null) {
      sum += v; count++;
      if (count === p) { prev = sum / p; out[i] = prev; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiSeries(closes: number[], p = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= p) {
      avgGain += gain; avgLoss += loss;
      if (i === p) {
        avgGain /= p; avgLoss /= p;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
      continue;
    }
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function trAt(candles: Candle[], i: number): number {
  if (i === 0) return candles[0].h - candles[0].l;
  const pc = candles[i - 1].c;
  return Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
}

function atrWilder(candles: Candle[], p = 14): number[] {
  const out = new Array(candles.length).fill(NaN);
  let atr = 0;
  for (let i = 1; i < candles.length; i++) {
    if (i <= p) {
      atr += trAt(candles, i);
      if (i === p) { atr /= p; out[i] = atr; }
      continue;
    }
    atr = (atr * (p - 1) + trAt(candles, i)) / p;
    out[i] = atr;
  }
  return out;
}

function macdSeries(closes: number[]) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const line: (number | null)[] = closes.map((_, i) =>
    e12[i] != null && e26[i] != null ? e12[i]! - e26[i]! : null);
  const signal = emaOfSparse(line, 9);
  const hist: (number | null)[] = line.map((v, i) =>
    v != null && signal[i] != null ? v - signal[i]! : null);
  return { line, signal, hist };
}

function adxSeries(candles: Candle[], p = 14) {
  const n = candles.length;
  const plusDi = new Array(n).fill(NaN), minusDi = new Array(n).fill(NaN), adx = new Array(n).fill(NaN);
  let trS = 0, pS = 0, mS = 0, dxS = 0, dxCount = 0;
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const dn = candles[i - 1].l - candles[i].l;
    const pDM = up > dn && up > 0 ? up : 0;
    const mDM = dn > up && dn > 0 ? dn : 0;
    const tr = trAt(candles, i);
    if (i <= p) { trS += tr; pS += pDM; mS += mDM; if (i < p) continue; }
    else { trS = trS - trS / p + tr; pS = pS - pS / p + pDM; mS = mS - mS / p + mDM; }
    if (trS <= 0) continue;
    const pdi = 100 * pS / trS, mdi = 100 * mS / trS;
    plusDi[i] = pdi; minusDi[i] = mdi;
    const dx = pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    if (i < 2 * p) { dxS += dx; dxCount++; if (i === 2 * p - 1) adx[i] = dxS / dxCount; continue; }
    adx[i] = (adx[i - 1] * (p - 1) + dx) / p;
  }
  return { plusDi, minusDi, adx };
}

function stochSeries(candles: Candle[], kP = 14, dP = 3) {
  const n = candles.length;
  const k = new Array(n).fill(NaN), d = new Array(n).fill(NaN);
  for (let i = kP - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let w = i - kP + 1; w <= i; w++) { hi = Math.max(hi, candles[w].h); lo = Math.min(lo, candles[w].l); }
    k[i] = hi > lo ? 100 * (candles[i].c - lo) / (hi - lo) : 50;
  }
  for (let i = kP + dP - 2; i < n; i++) {
    let s = 0;
    for (let w = i - dP + 1; w <= i; w++) s += k[w];
    d[i] = s / dP;
  }
  return { k, d };
}

function obvSeries(candles: Candle[]): number[] {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    out[i] = out[i - 1] + (candles[i].c > candles[i - 1].c ? candles[i].v : candles[i].c < candles[i - 1].c ? -candles[i].v : 0);
  }
  return out;
}

function mfiSeries(candles: Candle[], p = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let pos = 0, neg = 0;
  const tp = candles.map((c) => (c.h + c.l + c.c) / 3);
  const flows: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const mf = tp[i] * candles[i].v;
    const flow = tp[i] > tp[i - 1] ? { pos: mf, neg: 0 } : { pos: 0, neg: mf };
    flows.push(flow);
    pos += flow.pos; neg += flow.neg;
    if (flows.length > p) { const old = flows.shift()!; pos -= old.pos; neg -= old.neg; }
    if (flows.length === p) out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

function bollingerSeries(closes: number[], p = 20, mult = 2) {
  const n = closes.length;
  const mid = new Array(n).fill(NaN), upper = new Array(n).fill(NaN), lower = new Array(n).fill(NaN);
  for (let i = p - 1; i < n; i++) {
    let s = 0;
    for (let w = i - p + 1; w <= i; w++) s += closes[w];
    const m = s / p;
    let v = 0;
    for (let w = i - p + 1; w <= i; w++) v += (closes[w] - m) ** 2;
    const sd = Math.sqrt(v / p);
    mid[i] = m; upper[i] = m + mult * sd; lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

function highestHigh(candles: Candle[], i: number, p: number) {
  let hi = -Infinity;
  for (let w = Math.max(0, i - p + 1); w <= i; w++) hi = Math.max(hi, candles[w].h);
  return hi;
}
function lowestLow(candles: Candle[], i: number, p: number) {
  let lo = Infinity;
  for (let w = Math.max(0, i - p + 1); w <= i; w++) lo = Math.min(lo, candles[w].l);
  return lo;
}

/** Swing pivots confirmed k bars later: at bar i only pivots with p <= i-k are known. */
function pivotState(candles: Candle[], k = 2) {
  const n = candles.length;
  const ph1 = new Float64Array(n).fill(NaN), ph2 = new Float64Array(n).fill(NaN);
  const pl1 = new Float64Array(n).fill(NaN), pl2 = new Float64Array(n).fill(NaN);
  const highs: number[] = [], lows: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = i - k;
    if (p >= k) {
      let isHigh = true, isLow = true;
      for (let w = p - k; w <= p + k; w++) {
        if (w === p) continue;
        if (candles[w].h > candles[p].h) isHigh = false;
        if (candles[w].l < candles[p].l) isLow = false;
      }
      if (isHigh) highs.push(candles[p].h);
      if (isLow) lows.push(candles[p].l);
    }
    if (i >= k) {
      ph1[i] = highs.length ? highs[highs.length - 1] : NaN;
      ph2[i] = highs.length > 1 ? highs[highs.length - 2] : NaN;
      pl1[i] = lows.length ? lows[lows.length - 1] : NaN;
      pl2[i] = lows.length > 1 ? lows[lows.length - 2] : NaN;
    }
  }
  return { ph1, ph2, pl1, pl2 };
}

// ---- candlestick shapes -------------------------------------------------------

interface Shape { range: number; body: number; bodyFrac: number; upperFrac: number; lowerFrac: number; bullish: boolean; }
function shape(c: Candle): Shape | null {
  const range = c.h - c.l;
  if (range <= 0) return null;
  const body = Math.abs(c.c - c.o);
  return {
    range, body, bodyFrac: body / range,
    upperFrac: (c.h - Math.max(c.o, c.c)) / range,
    lowerFrac: (Math.min(c.o, c.c) - c.l) / range,
    bullish: c.c > c.o,
  };
}

// ---- the library --------------------------------------------------------------

export const INDICATORS: Indicator[] = [
  // ---- trend (state votes) ----
  { name: "ema_stack_9_21_50", family: "trend", votes: (cs) => {
    const closes = cs.map((c) => c.c);
    const e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21), e50 = emaSeries(closes, 50);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (e9[i] == null || e21[i] == null || e50[i] == null) continue;
      out[i] = sgn(sgn(e9[i]! - e21[i]!) + sgn(e21[i]! - e50[i]!));
    }
    return out;
  }},
  { name: "ema50_above_200", family: "trend", votes: (cs) => {
    const e50 = emaSeries(cs.map((c) => c.c), 50), e200 = emaSeries(cs.map((c) => c.c), 200);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (e50[i] == null || e200[i] == null) continue;
      out[i] = sgn(e50[i]! - e200[i]!);
    }
    return out;
  }},
  { name: "price_vs_sma200", family: "trend", votes: (cs) => {
    const s = smaSeries(cs.map((c) => c.c), 200);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) { if (s[i] == null) continue; out[i] = sgn(cs[i].c - s[i]!); }
    return out;
  }},
  { name: "sma50_slope_3", family: "trend", votes: (cs) => {
    const s = smaSeries(cs.map((c) => c.c), 50);
    const out = new Int8Array(cs.length);
    for (let i = 3; i < cs.length; i++) { if (s[i] == null || s[i - 3] == null) continue; out[i] = sgn(s[i]! - s[i - 3]!); }
    return out;
  }},
  { name: "macd_line_vs_signal", family: "trend", votes: (cs) => {
    const { line, signal } = macdSeries(cs.map((c) => c.c));
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (line[i] == null || signal[i] == null) continue;
      out[i] = sgn(line[i]! - signal[i]!);
    }
    return out;
  }},
  { name: "macd_hist_sign", family: "trend", votes: (cs) => {
    const { hist } = macdSeries(cs.map((c) => c.c));
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) { if (hist[i] == null) continue; out[i] = sgn(hist[i]!); }
    return out;
  }},
  { name: "macd_cross_event", family: "trend", votes: (cs) => {
    const { hist } = macdSeries(cs.map((c) => c.c));
    const out = new Int8Array(cs.length);
    for (let i = 1; i < cs.length; i++) {
      if (hist[i] == null || hist[i - 1] == null) continue;
      if (hist[i - 1]! <= 0 && hist[i]! > 0) out[i] = 1;
      else if (hist[i - 1]! >= 0 && hist[i]! < 0) out[i] = -1;
    }
    return out;
  }},
  { name: "dpo_20", family: "trend", votes: (cs) => {
    const s = smaSeries(cs.map((c) => c.c), 20);
    const out = new Int8Array(cs.length);
    for (let i = 11; i < cs.length; i++) { if (s[i - 11] == null) continue; out[i] = sgn(cs[i].c - s[i - 11]!); }
    return out;
  }},
  { name: "supertrend_10_3", family: "trend", votes: (cs) => {
    const atr = atrWilder(cs, 10);
    const out = new Int8Array(cs.length);
    let dir = 0, finalUpper = NaN, finalLower = NaN;
    for (let i = 0; i < cs.length; i++) {
      if (Number.isNaN(atr[i])) continue;
      const hl2 = (cs[i].h + cs[i].l) / 2;
      let bu = hl2 + 3 * atr[i], bl = hl2 - 3 * atr[i];
      if (!Number.isNaN(finalUpper)) {
        bu = cs[i - 1].c > finalUpper ? bu : Math.min(bu, finalUpper);
        bl = cs[i - 1].c < finalLower ? bl : Math.max(bl, finalLower);
      }
      if (dir === 0) { dir = cs[i].c > hl2 ? 1 : -1; }
      else if (dir === 1 && cs[i].c < finalLower) dir = -1;
      else if (dir === -1 && cs[i].c > finalUpper) dir = 1;
      finalUpper = bu; finalLower = bl;
      if (i >= 10) out[i] = dir as 1 | -1;
    }
    return out;
  }},
  { name: "adx_di_14", family: "trend", votes: (cs) => {
    const { adx, plusDi, minusDi } = adxSeries(cs, 14);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (!Number.isFinite(adx[i]) || adx[i] < 20) continue;
      out[i] = sgn(plusDi[i] - minusDi[i]);
    }
    return out;
  }},
  { name: "aroon_25", family: "trend", votes: (cs) => {
    const out = new Int8Array(cs.length);
    const p = 25;
    for (let i = p; i < cs.length; i++) {
      let hiIdx = i, loIdx = i;
      for (let w = i - p; w <= i; w++) {
        if (cs[w].h >= cs[hiIdx].h) hiIdx = w;
        if (cs[w].l <= cs[loIdx].l) loIdx = w;
      }
      const sinceHi = i - hiIdx, sinceLo = i - loIdx;
      out[i] = sinceHi === sinceLo ? 0 : sinceHi < sinceLo ? 1 : -1;
    }
    return out;
  }},
  { name: "trix_15", family: "trend", votes: (cs) => {
    const closes = cs.map((c) => c.c);
    const e1 = emaSeries(closes, 15), e2 = emaOfSparse(e1, 15), e3 = emaOfSparse(e2, 15);
    const out = new Int8Array(cs.length);
    for (let i = 1; i < cs.length; i++) {
      if (e3[i] == null || e3[i - 1] == null) continue;
      out[i] = sgn(e3[i]! - e3[i - 1]!);
    }
    return out;
  }},
  { name: "ichimoku_tenkan_kijun", family: "trend", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 26; i < cs.length; i++) {
      const tenkan = (highestHigh(cs, i, 9) + lowestLow(cs, i, 9)) / 2;
      const kijun = (highestHigh(cs, i, 26) + lowestLow(cs, i, 26)) / 2;
      out[i] = tenkan > kijun && cs[i].c > kijun ? 1 : tenkan < kijun && cs[i].c < kijun ? -1 : 0;
    }
    return out;
  }},
  { name: "keltner_break_20_2atr", family: "trend", votes: (cs) => {
    const e = emaSeries(cs.map((c) => c.c), 20), atr = atrWilder(cs, 10);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (e[i] == null || Number.isNaN(atr[i])) continue;
      if (cs[i].c > e[i]! + 2 * atr[i]) out[i] = 1;
      else if (cs[i].c < e[i]! - 2 * atr[i]) out[i] = -1;
    }
    return out;
  }},
  { name: "donchian_break_20", family: "structure", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 20; i < cs.length; i++) {
      const hi = highestHigh(cs, i - 1, 20), lo = lowestLow(cs, i - 1, 20);
      if (cs[i].c > hi) out[i] = 1;
      else if (cs[i].c < lo) out[i] = -1;
    }
    return out;
  }},
  // ---- momentum ----
  { name: "rsi_level_14", family: "momentum", votes: (cs) => {
    const r = rsiSeries(cs.map((c) => c.c), 14);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (r[i] == null) continue;
      out[i] = r[i]! > 55 ? 1 : r[i]! < 45 ? -1 : 0;
    }
    return out;
  }},
  { name: "rsi_cross_50_event", family: "momentum", votes: (cs) => {
    const r = rsiSeries(cs.map((c) => c.c), 14);
    const out = new Int8Array(cs.length);
    for (let i = 1; i < cs.length; i++) {
      if (r[i] == null || r[i - 1] == null) continue;
      if (r[i - 1]! <= 50 && r[i]! > 50) out[i] = 1;
      else if (r[i - 1]! >= 50 && r[i]! < 50) out[i] = -1;
    }
    return out;
  }},
  { name: "rsi_divergence", family: "momentum", votes: (cs) => {
    const closes = cs.map((c) => c.c), r = rsiSeries(closes, 14);
    const out = new Int8Array(cs.length);
    for (let i = 20; i < cs.length; i++) {
      if (r[i] == null) continue;
      let minIdx = i, maxIdx = i;
      for (let w = i - 19; w <= i; w++) {
        if (closes[w] < closes[minIdx]) minIdx = w;
        if (closes[w] > closes[maxIdx]) maxIdx = w;
      }
      if (minIdx <= i - 3 && r[i] != null && r[minIdx] != null && r[i]! > r[minIdx]! + 2) out[i] = 1;
      else if (maxIdx <= i - 3 && r[i] != null && r[maxIdx] != null && r[i]! < r[maxIdx]! - 2) out[i] = -1;
    }
    return out;
  }},
  { name: "stoch_kd_14_3", family: "momentum", votes: (cs) => {
    const { k, d } = stochSeries(cs, 14, 3);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (!Number.isFinite(k[i]) || !Number.isFinite(d[i])) continue;
      out[i] = k[i] > d[i] && k[i] < 80 ? 1 : k[i] < d[i] && k[i] > 20 ? -1 : 0;
    }
    return out;
  }},
  { name: "stoch_overbought_meanrev", family: "momentum", votes: (cs) => {
    const { k } = stochSeries(cs, 14, 3);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (!Number.isFinite(k[i])) continue;
      out[i] = k[i] > 80 ? -1 : k[i] < 20 ? 1 : 0;
    }
    return out;
  }},
  { name: "cci_20", family: "momentum", votes: (cs) => {
    const tp = cs.map((c) => (c.h + c.l + c.c) / 3);
    const s = smaSeries(tp, 20);
    const out = new Int8Array(cs.length);
    for (let i = 19; i < cs.length; i++) {
      if (s[i] == null) continue;
      let md = 0;
      for (let w = i - 19; w <= i; w++) md += Math.abs(tp[w] - s[i]!);
      md /= 20;
      const cci = md > 0 ? (tp[i] - s[i]!) / (0.015 * md) : 0;
      out[i] = sgn(cci);
    }
    return out;
  }},
  { name: "williams_r_14", family: "momentum", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 13; i < cs.length; i++) {
      const hi = highestHigh(cs, i, 14), lo = lowestLow(cs, i, 14);
      if (hi <= lo) continue;
      const wr = -100 * (hi - cs[i].c) / (hi - lo);
      out[i] = wr > -50 ? 1 : -1;
    }
    return out;
  }},
  { name: "roc_10", family: "momentum", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 10; i < cs.length; i++) out[i] = sgn(cs[i].c / cs[i - 10] - 1);
    return out;
  }},
  { name: "ultimate_osc_7_14_28", family: "momentum", votes: (cs) => {
    const out = new Int8Array(cs.length);
    const bp: number[] = [], tr: number[] = [];
    for (let i = 0; i < cs.length; i++) {
      const pc = i > 0 ? cs[i - 1].c : cs[i].c;
      bp.push(cs[i].c - Math.min(cs[i].l, pc));
      tr.push(Math.max(cs[i].h, pc) - Math.min(cs[i].l, pc));
    }
    const sumOver = (arr: number[], i: number, p: number) => {
      let s = 0;
      for (let w = i - p + 1; w <= i; w++) s += arr[w];
      return s;
    };
    for (let i = 28; i < cs.length; i++) {
      const a7 = sumOver(bp, i, 7) / sumOver(tr, i, 7);
      const a14 = sumOver(bp, i, 14) / sumOver(tr, i, 14);
      const a28 = sumOver(bp, i, 28) / sumOver(tr, i, 28);
      const uo = 100 * (4 * a7 + 2 * a14 + a28) / 7;
      out[i] = sgn(uo - 50);
    }
    return out;
  }},
  // ---- volume ----
  { name: "obv_slope_10", family: "volume", votes: (cs) => {
    const o = obvSeries(cs);
    const out = new Int8Array(cs.length);
    for (let i = 10; i < cs.length; i++) out[i] = sgn(o[i] - o[i - 10]);
    return out;
  }},
  { name: "obv_price_divergence", family: "volume", votes: (cs) => {
    const o = obvSeries(cs);
    const out = new Int8Array(cs.length);
    for (let i = 10; i < cs.length; i++) {
      const obvUp = o[i] > o[i - 10], pxUp = cs[i].c > cs[i - 10].c;
      if (obvUp && !pxUp) out[i] = 1;
      else if (!obvUp && pxUp) out[i] = -1;
    }
    return out;
  }},
  { name: "mfi_14_extreme", family: "volume", votes: (cs) => {
    const m = mfiSeries(cs, 14);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (m[i] == null) continue;
      out[i] = m[i]! < 20 ? 1 : m[i]! > 80 ? -1 : 0;
    }
    return out;
  }},
  { name: "volume_surge_dir", family: "volume", votes: (cs) => {
    const vols = cs.map((c) => c.v);
    const s = smaSeries(vols, 20);
    const out = new Int8Array(cs.length);
    for (let i = 19; i < cs.length; i++) {
      if (s[i] == null || s[i]! <= 0) continue;
      if (cs[i].v > 2 * s[i]!) out[i] = sgn(cs[i].c - cs[i].o);
    }
    return out;
  }},
  { name: "cvd_slope_10", family: "volume", votes: (cs) => {
    const out = new Int8Array(cs.length);
    const delta = cs.map((c) => c.v * sgn(c.c - c.o));
    for (let i = 10; i < cs.length; i++) {
      let s = 0;
      for (let w = i - 9; w <= i; w++) s += delta[w];
      out[i] = sgn(s);
    }
    return out;
  }},
  // ---- volatility ----
  { name: "bb_breakout_20_2", family: "volatility", votes: (cs) => {
    const { upper, lower } = bollingerSeries(cs.map((c) => c.c), 20, 2);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (!Number.isFinite(upper[i])) continue;
      if (cs[i].c > upper[i]) out[i] = 1;
      else if (cs[i].c < lower[i]) out[i] = -1;
    }
    return out;
  }},
  { name: "bb_squeeze_break", family: "volatility", votes: (cs) => {
    const closes = cs.map((c) => c.c);
    const { upper, lower, mid } = bollingerSeries(closes, 20, 2);
    const out = new Int8Array(cs.length);
    const widths: number[] = [];
    for (let i = 0; i < cs.length; i++) {
      if (Number.isFinite(upper[i]) && mid[i] > 0) widths.push((upper[i] - lower[i]) / mid[i]);
      if (i < 100 || widths.length < 100) continue;
      const last100 = widths.slice(-100);
      const rank = last100.filter((w) => w < widths[widths.length - 1]).length / 100;
      if (rank < 0.25) {
        if (cs[i].c > upper[i - 1]) out[i] = 1;
        else if (cs[i].c < lower[i - 1]) out[i] = -1;
      }
    }
    return out;
  }},
  // ---- structure ----
  { name: "swing_structure", family: "structure", votes: (cs) => {
    const { ph1, ph2, pl1, pl2 } = pivotState(cs, 2);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (Number.isNaN(ph2[i]) || Number.isNaN(pl2[i])) continue;
      if (ph1[i] > ph2[i] && pl1[i] > pl2[i]) out[i] = 1;
      else if (ph1[i] < ph2[i] && pl1[i] < pl2[i]) out[i] = -1;
    }
    return out;
  }},
  { name: "sr_pressure_2atr", family: "structure", votes: (cs) => {
    const { ph1, pl1 } = pivotState(cs, 2);
    const atr = atrWilder(cs, 14);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (Number.isNaN(atr[i])) continue;
      const nearSup = !Number.isNaN(pl1[i]) && cs[i].c - pl1[i] < 2 * atr[i];
      const nearRes = !Number.isNaN(ph1[i]) && ph1[i] - cs[i].c < 2 * atr[i];
      out[i] = nearSup && nearRes ? 0 : nearSup ? 1 : nearRes ? -1 : 0;
    }
    return out;
  }},
  // ---- candlestick patterns (event votes) ----
  { name: "bullish_engulfing", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 1; i < cs.length; i++) {
      const a = shape(cs[i - 1]), b = shape(cs[i]);
      if (!a || !b) continue;
      if (!a.bullish && b.bullish && b.o <= a.c && b.c >= a.o && b.body >= a.body) out[i] = 1;
    }
    return out;
  }},
  { name: "bearish_engulfing", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 1; i < cs.length; i++) {
      const a = shape(cs[i - 1]), b = shape(cs[i]);
      if (!a || !b) continue;
      if (a.bullish && !b.bullish && b.o >= a.c && b.c <= a.o && b.body >= a.body) out[i] = -1;
    }
    return out;
  }},
  { name: "hammer", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      const s = shape(cs[i]);
      if (s && s.lowerFrac >= 0.5 && s.bodyFrac <= 0.3 && s.upperFrac <= 0.15) out[i] = 1;
    }
    return out;
  }},
  { name: "shooting_star", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      const s = shape(cs[i]);
      if (s && s.upperFrac >= 0.5 && s.bodyFrac <= 0.3 && s.lowerFrac <= 0.15) out[i] = -1;
    }
    return out;
  }},
  { name: "morning_star", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 2; i < cs.length; i++) {
      const a = shape(cs[i - 2]), b = shape(cs[i - 1]), c = shape(cs[i]);
      if (!a || !b || !c) continue;
      if (!a.bullish && a.bodyFrac >= 0.5 && b.bodyFrac <= 0.3 && c.bullish && cs[i].c > (cs[i - 2].o + cs[i - 2].c) / 2) out[i] = 1;
    }
    return out;
  }},
  { name: "evening_star", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 2; i < cs.length; i++) {
      const a = shape(cs[i - 2]), b = shape(cs[i - 1]), c = shape(cs[i]);
      if (!a || !b || !c) continue;
      if (a.bullish && a.bodyFrac >= 0.5 && b.bodyFrac <= 0.3 && !c.bullish && cs[i].c < (cs[i - 2].o + cs[i - 2].c) / 2) out[i] = -1;
    }
    return out;
  }},
  { name: "piercing_line", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 1; i < cs.length; i++) {
      const a = shape(cs[i - 1]), b = shape(cs[i]);
      if (!a || !b) continue;
      if (!a.bullish && a.bodyFrac >= 0.4 && b.bullish && cs[i].o < cs[i - 1].c && cs[i].c > (cs[i - 1].o + cs[i - 1].c) / 2 && cs[i].c < cs[i - 1].o) out[i] = 1;
    }
    return out;
  }},
  { name: "dark_cloud_cover", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 1; i < cs.length; i++) {
      const a = shape(cs[i - 1]), b = shape(cs[i]);
      if (!a || !b) continue;
      if (a.bullish && a.bodyFrac >= 0.4 && !b.bullish && cs[i].o > cs[i - 1].c && cs[i].c < (cs[i - 1].o + cs[i - 1].c) / 2 && cs[i].c > cs[i - 1].o) out[i] = -1;
    }
    return out;
  }},
  { name: "three_white_soldiers", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 2; i < cs.length; i++) {
      const s = [shape(cs[i - 2]), shape(cs[i - 1]), shape(cs[i])];
      if (s.some((x) => x == null)) continue;
      if (s.every((x) => x!.bullish && x!.bodyFrac >= 0.5) && cs[i].c > cs[i - 1].c && cs[i - 1].c > cs[i - 2].c) out[i] = 1;
    }
    return out;
  }},
  { name: "three_black_crows", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 2; i < cs.length; i++) {
      const s = [shape(cs[i - 2]), shape(cs[i - 1]), shape(cs[i])];
      if (s.some((x) => x == null)) continue;
      if (s.every((x) => !x!.bullish && x!.bodyFrac >= 0.5) && cs[i].c < cs[i - 1].c && cs[i - 1].c < cs[i - 2].c) out[i] = -1;
    }
    return out;
  }},
  { name: "marubozu_dir", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      const s = shape(cs[i]);
      if (s && s.bodyFrac >= 0.85) out[i] = sgn(cs[i].c - cs[i].o) as 1 | -1;
    }
    return out;
  }},
  { name: "harami_reversal", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 1; i < cs.length; i++) {
      const a = shape(cs[i - 1]), b = shape(cs[i]);
      if (!a || !b) continue;
      const inside = Math.max(cs[i].o, cs[i].c) <= Math.max(cs[i - 1].o, cs[i - 1].c)
        && Math.min(cs[i].o, cs[i].c) >= Math.min(cs[i - 1].o, cs[i - 1].c);
      if (!inside || a.bodyFrac < 0.5 || b.bodyFrac >= a.bodyFrac) continue;
      if (!a.bullish && b.bullish) out[i] = 1;
      else if (a.bullish && !b.bullish) out[i] = -1;
    }
    return out;
  }},
  { name: "three_outside_up", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 2; i < cs.length; i++) {
      const first = shape(cs[i - 2]), second = shape(cs[i - 1]), third = shape(cs[i]);
      if (!first || !second || !third) continue;
      if (first.bullish || !second.bullish || !third.bullish) continue;
      if (second.o <= first.c && second.c >= first.o && second.body >= 1.3 * first.body && cs[i].c > cs[i - 1].c) out[i] = 1;
    }
    return out;
  }},
  { name: "gravestone_doji", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      const s = shape(cs[i]);
      if (s && s.bodyFrac <= 0.1 && s.upperFrac >= 0.6 && s.lowerFrac <= 0.1) out[i] = -1;
    }
    return out;
  }},
  { name: "hanging_man", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    const e50 = emaSeries(cs.map((c) => c.c), 50);
    for (let i = 0; i < cs.length; i++) {
      const s = shape(cs[i]);
      if (s && e50[i] != null && s.bodyFrac <= 0.25 && s.lowerFrac >= 0.5 && s.upperFrac <= 0.1 && cs[i].c > e50[i]!) out[i] = -1;
    }
    return out;
  }},
  { name: "matching_high", family: "pattern", votes: (cs) => {
    const out = new Int8Array(cs.length);
    for (let i = 1; i < cs.length; i++) {
      if (Math.abs(cs[i].c - cs[i - 1].c) <= 0.001 * cs[i - 1].c && cs[i].c >= cs[i - 1].c) out[i] = -1;
    }
    return out;
  }},
  // ---- chassis replicas (direction.ts's six votes, ranked like everyone else) ----
  { name: "chassis_trend", family: "chassis", votes: (cs) => {
    const closes = cs.map((c) => c.c);
    const e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21), e50 = emaSeries(closes, 50);
    const atr = atrWilder(cs, 14);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (e9[i] == null || e21[i] == null || e50[i] == null || Number.isNaN(atr[i])) continue;
      let vote = sgn(e9[i]! - e21[i]!) * 0.5 + sgn(e21[i]! - e50[i]!) * 0.5;
      if (i >= 3 && e21[i - 3] != null) vote += clamp((e21[i]! - e21[i - 3]!) / (3 * atr[i]), -1, 1) * 0.5;
      out[i] = sgn(clamp(vote / 1.5, -1, 1)) as 1 | -1 | 0;
    }
    return out;
  }},
  { name: "chassis_momentum", family: "chassis", votes: (cs) => {
    const closes = cs.map((c) => c.c);
    const r = rsiSeries(closes, 14);
    const { hist } = macdSeries(closes);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      const votes: number[] = [];
      if (r[i] != null) votes.push(clamp((r[i]! - 50) / 30, -1, 1));
      if (hist[i] != null) votes.push(clamp(hist[i]! / (closes[i] * 0.002 || 1), -1, 1));
      if (!votes.length) continue;
      out[i] = sgn(votes.reduce((a, b) => a + b, 0) / votes.length) as 1 | -1 | 0;
    }
    return out;
  }},
  { name: "chassis_flow", family: "chassis", votes: (cs) => {
    const o = obvSeries(cs);
    const out = new Int8Array(cs.length);
    for (let i = 10; i < cs.length; i++) {
      const avgVolume = cs.slice(i - 9, i + 1).reduce((a, c) => a + c.v, 0) / 10;
      if (!avgVolume) continue;
      out[i] = sgn(clamp((o[i] - o[i - 10]) / (avgVolume * 10), -1, 1)) as 1 | -1 | 0;
    }
    return out;
  }},
  { name: "chassis_location", family: "chassis", votes: (cs) => {
    const { ph1, pl1 } = pivotState(cs, 2);
    const atr = atrWilder(cs, 14);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (Number.isNaN(atr[i])) continue;
      const nearSup = !Number.isNaN(pl1[i]) && cs[i].c - pl1[i] < 2 * atr[i];
      const nearRes = !Number.isNaN(ph1[i]) && ph1[i] - cs[i].c < 2 * atr[i];
      out[i] = nearSup && nearRes ? 0 : nearSup ? 1 : nearRes ? -1 : 0;
    }
    return out;
  }},
  { name: "chassis_pattern5", family: "chassis", votes: (cs) => {
    const soldiers = INDICATORS.find((i) => i.name === "three_white_soldiers")!.votes(cs);
    const outside = INDICATORS.find((i) => i.name === "three_outside_up")!.votes(cs);
    const gravestone = INDICATORS.find((i) => i.name === "gravestone_doji")!.votes(cs);
    const hanging = INDICATORS.find((i) => i.name === "hanging_man")!.votes(cs);
    const matching = INDICATORS.find((i) => i.name === "matching_high")!.votes(cs);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      const vote = soldiers[i] + outside[i] - gravestone[i] - hanging[i] - matching[i];
      out[i] = sgn(clamp(vote, -1, 1)) as 1 | -1 | 0;
    }
    return out;
  }},
  { name: "chassis_structure", family: "chassis", votes: (cs) => {
    const { ph1, ph2, pl1, pl2 } = pivotState(cs, 2);
    const out = new Int8Array(cs.length);
    for (let i = 0; i < cs.length; i++) {
      if (Number.isNaN(ph2[i]) || Number.isNaN(pl2[i])) continue;
      const upImpulse = ph1[i] > ph2[i] && pl1[i] > pl2[i];
      const dnImpulse = ph1[i] < ph2[i] && pl1[i] < pl2[i];
      if (upImpulse) out[i] = 1;
      else if (dnImpulse) out[i] = -1;
      else {
        const drift = sgn((ph1[i] - ph2[i]) + (pl1[i] - pl2[i]));
        out[i] = drift !== 0 ? (drift * -1 as 1 | -1) : 0; // corrective: against the shallow drift
      }
    }
    return out;
  }},
];
