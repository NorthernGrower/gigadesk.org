/** Technical indicator math. Every function returns an array aligned to the input, warm-up slots are null. */

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastE = ema(values, fast);
  const slowE = ema(values, slow);
  const line = values.map((_, i) =>
    fastE[i] != null && slowE[i] != null ? fastE[i] - slowE[i] : null,
  );
  const valid = line.filter((v) => v != null);
  const smoothed = ema(valid, signalPeriod);
  const signal = new Array(values.length).fill(null);
  let vi = 0;
  for (let i = 0; i < values.length; i++) {
    if (line[i] != null) {
      signal[i] = smoothed[vi] ?? null;
      vi += 1;
    }
  }
  const hist = line.map((v, i) =>
    v != null && signal[i] != null ? v - signal[i] : null,
  );
  return { macd: line, signal, hist };
}

export function bollinger(values, period = 20, mult = 2) {
  const middle = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = win.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { middle, upper, lower };
}

export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (!candles.length) return out;
  const tr = candles.map((c, i) =>
    i === 0
      ? c.h - c.l
      : Math.max(
          c.h - c.l,
          Math.abs(c.h - candles[i - 1].c),
          Math.abs(c.l - candles[i - 1].c),
        ),
  );
  if (tr.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Bollinger band width as a percentage of the middle band — the volatility squeeze read. */
export function bollingerWidth(values, period = 20, mult = 2) {
  const bb = bollinger(values, period, mult);
  return bb.middle.map((m, i) =>
    m && bb.upper[i] != null ? ((bb.upper[i] - bb.lower[i]) / m) * 100 : null,
  );
}

/**
 * Wilder's directional movement system: ADX for trend strength plus +DI / -DI
 * for which side owns the tape. The professional test for trending vs chop.
 */
export function adx(candles, period = 14) {
  const n = candles.length;
  const out = {
    adx: new Array(n).fill(null),
    plusDi: new Array(n).fill(null),
    minusDi: new Array(n).fill(null),
  };
  if (n <= period * 2) return out;

  const tr = new Array(n).fill(0);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
  }

  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += pdm[i];
    mS += mdm[i];
  }

  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + pdm[i];
      mS = mS - mS / period + mdm[i];
    }
    const pdi = trS ? (100 * pS) / trS : 0;
    const mdi = trS ? (100 * mS) / trS : 0;
    out.plusDi[i] = pdi;
    out.minusDi[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum ? (100 * Math.abs(pdi - mdi)) / sum : 0;
  }

  let adxVal = null;
  let count = 0;
  let sum = 0;
  for (let i = period; i < n; i++) {
    if (dx[i] == null) continue;
    if (adxVal == null) {
      sum += dx[i];
      count += 1;
      if (count === period) {
        adxVal = sum / period;
        out.adx[i] = adxVal;
      }
    } else {
      adxVal = (adxVal * (period - 1) + dx[i]) / period;
      out.adx[i] = adxVal;
    }
  }
  return out;
}

/** Stochastic oscillator: %K smoothed, plus its %D signal line. */
export function stochastic(candles, kPeriod = 14, smoothK = 3, dPeriod = 3) {
  const n = candles.length;
  const raw = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    const win = candles.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...win.map((c) => c.h));
    const ll = Math.min(...win.map((c) => c.l));
    raw[i] = hh - ll ? ((candles[i].c - ll) / (hh - ll)) * 100 : 50;
  }
  const k = new Array(n).fill(null);
  for (let i = kPeriod + smoothK - 2; i < n; i++) {
    let s = 0;
    for (let j = i - smoothK + 1; j <= i; j++) s += raw[j];
    k[i] = s / smoothK;
  }
  const d = new Array(n).fill(null);
  for (let i = kPeriod + smoothK + dPeriod - 3; i < n; i++) {
    let s = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) s += k[j];
    d[i] = s / dPeriod;
  }
  return { k, d };
}

/** On-balance volume: cumulative volume signed by the candle direction. */
export function obv(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const dir = Math.sign(candles[i].c - candles[i - 1].c);
    out[i] = out[i - 1] + dir * (candles[i].v || 0);
  }
  return out;
}

/** Rolling volume-weighted average price over the anchor window. */
export function rollingVwap(candles, period = 24) {
  const out = new Array(candles.length).fill(null);
  if (period < 2) return out;
  for (let i = period - 1; i < candles.length; i++) {
    let pv = 0;
    let vv = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const typical = (candles[j].h + candles[j].l + candles[j].c) / 3;
      const vol = candles[j].v || 0;
      pv += typical * vol;
      vv += vol;
    }
    out[i] = vv ? pv / vv : null;
  }
  return out;
}

/** Fractal swing pivots: a high/low with `lookback` lower/higher bars on both sides. */
export function pivots(candles, lookback = 2) {
  const out = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) out.push({ i, price: candles[i].h, kind: "high" });
    else if (isLow) out.push({ i, price: candles[i].l, kind: "low" });
  }
  return out;
}

/** Market structure read: higher highs with higher lows, lower lows with lower highs, or neither. */
export function swingTrend(pivotList) {
  const highs = pivotList.filter((p) => p.kind === "high").slice(-2);
  const lows = pivotList.filter((p) => p.kind === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "range";
  const higherHigh = highs[1].price > highs[0].price;
  const higherLow = lows[1].price > lows[0].price;
  if (higherHigh && higherLow) return "up";
  if (!higherHigh && !higherLow) return "down";
  return "range";
}

/** Folds candles into a higher timeframe (factor 4 turns 1h bars into 4h bars). */
export function resample(candles, factor = 4) {
  const out = [];
  for (let i = 0; i < candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    if (!group.length) continue;
    out.push({
      t: group[0].t,
      o: group[0].o,
      h: Math.max(...group.map((c) => c.h)),
      l: Math.min(...group.map((c) => c.l)),
      c: group[group.length - 1].c,
      v: group.reduce((a, c) => a + (c.v || 0), 0),
    });
  }
  return out;
}

/** The last candle's shape: engulfing, hammer, shooting star, doji, marubozu or inside bar. */
export function candlePattern(candles) {
  const n = candles.length;
  if (n < 3) return { name: "none", bias: "neutral" };
  const c = candles[n - 1];
  const p = candles[n - 2];
  const body = Math.abs(c.c - c.o);
  const range = c.h - c.l || c.c * 0.0001;
  const upperWick = c.h - Math.max(c.c, c.o);
  const lowerWick = Math.min(c.c, c.o) - c.l;
  const bull = c.c > c.o;
  const prevBull = p.c > p.o;
  const prevBody = Math.abs(p.c - p.o);

  if (bull && !prevBull && c.c > p.o && c.o < p.c && body > prevBody * 1.1) {
    return { name: "bullish engulfing", bias: "up" };
  }
  if (!bull && prevBull && c.c < p.o && c.o > p.c && body > prevBody * 1.1) {
    return { name: "bearish engulfing", bias: "down" };
  }
  if (lowerWick > body * 2 && upperWick < body * 0.8 && body / range < 0.45) {
    return { name: "hammer", bias: "up" };
  }
  if (upperWick > body * 2 && lowerWick < body * 0.8 && body / range < 0.45) {
    return { name: "shooting star", bias: "down" };
  }
  if (body / range < 0.12) return { name: "doji", bias: "neutral" };
  if (body / range > 0.75) {
    return { name: bull ? "bullish marubozu" : "bearish marubozu", bias: bull ? "up" : "down" };
  }
  if (c.h < p.h && c.l > p.l) {
    return { name: "inside bar", bias: bull ? "up" : "down" };
  }
  return { name: "none", bias: "neutral" };
}

/** Classic RSI divergence: a lower low in price with a higher low in the oscillator, and the reverse. */
export function divergence(pivotList, oscSeries) {
  const read = (i) => (oscSeries[i] == null ? null : oscSeries[i]);
  const lows = pivotList.filter((p) => p.kind === "low").slice(-2);
  const highs = pivotList.filter((p) => p.kind === "high").slice(-2);

  if (lows.length === 2) {
    const [a, b] = lows;
    const oa = read(a.i);
    const ob = read(b.i);
    if (oa != null && ob != null && b.price < a.price && ob > oa + 2) {
      return { kind: "bullish", bars: b.i - a.i };
    }
  }
  if (highs.length === 2) {
    const [a, b] = highs;
    const oa = read(a.i);
    const ob = read(b.i);
    if (oa != null && ob != null && b.price > a.price && ob < oa - 2) {
      return { kind: "bearish", bars: b.i - a.i };
    }
  }
  return { kind: null, bars: 0 };
}

/** Percent change of a series over the last `lookback` steps (used for OBV flow). */
export function seriesChange(series, lookback) {
  const n = series.length;
  const a = series[n - 1 - lookback];
  const b = series[n - 1];
  if (a == null || b == null || a === 0) return 0;
  return ((b - a) / Math.abs(a)) * 100;
}

/** Where a value sits inside a set of values, 0-100 (used for the volatility squeeze read). */
export function percentileRank(values, value) {
  const clean = values.filter((v) => v != null && Number.isFinite(v));
  if (!clean.length || value == null) return 50;
  const below = clean.filter((v) => v <= value).length;
  return Math.round((below / clean.length) * 100);
}