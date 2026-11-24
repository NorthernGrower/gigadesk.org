// The V3 algorithm: the unified logic from the research workspace, ported to
// the live bot. Provenance: research/candlestick/docs/UNIFIED_LOGIC.md in the
// Gigadesk- repository. Every rule below is a rule that won its own study:
//
//   entry       a 55-bar breakout, or a Keltner thrust (close above EMA20 +
//               2xATR on above-average volume), on the last CLOSED daily bar
//   selection   $5m average daily dollar volume, BTC above its 200-day average
//   confluence  a Gate 4 survivor candle formation within the last 3 daily bars
//               (long line, bullish marubozu, shaven head)
//   exit        2xATR stop, no target, a 30-bar (day) horizon
//
// Measured out of sample on 37 Kraken pairs: +8.42% per trade after the
// per-pair cost model, 63 trades. A promising, not a proven, edge - which is
// why the toggle ships off and says so on screen.
//
// Two things deliberately differ from the app's scored engines: this is long
// only, and it reads daily bars regardless of the desk's scan timeframe.

export const V3 = {
  atr_period: 14,
  stop_atr: 2,
  horizon_bars: 30,
  min_adv_usd: 5_000_000,
  adv_bars: 20,
  breakout_bars: 55,
  keltner_ema: 20,
  keltner_atr: 2,
  confluence_window: 3,
  sma_regime: 200,
  min_bars: 90,
};

export const V3_LABEL = "V3 algorithm";

// Measured relaxation ladder (research/candlestick/docs/RELAXATION_LADDER.md):
//   strict      the original composition: 23 trades a year, +4.87% each, 6/6 folds
//   loose       confluence dropped, both breakout lengths, $1m floor,
//               BTC regime kept: more trades at a similar edge
//   aggressive  the same with the BTC regime gate off — the measured best on
//               trades per year, and the one with fewer positive folds
export const V3_PROFILES = {
  strict: { breakout_bars: [55], confluence_required: true, regime_required: true, min_adv_usd: 5_000_000 },
  loose: { breakout_bars: [55, 20], confluence_required: false, regime_required: true, min_adv_usd: 1_000_000 },
  aggressive: { breakout_bars: [55, 20], confluence_required: false, regime_required: false, min_adv_usd: 1_000_000 },
};

export type V3ProfileName = keyof typeof V3_PROFILES;

export function v3Profile(name?: string) {
  const key = (name || "loose") as V3ProfileName;
  return V3_PROFILES[key] || V3_PROFILES.loose;
}

// Wilder ATR, the same recursion the research engine uses.
export function atrSeries(candles: any[], period: number = V3.atr_period): (number | null)[] {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < 2) return out;
  let sum = 0;
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1];
    const bar = candles[i];
    const tr = Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - prev.c),
      Math.abs(bar.l - prev.c),
    );
    if (i <= period) {
      sum += tr;
      if (i === period) out[i] = sum / period;
      continue;
    }
    out[i] = (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

export function smaLast(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let total = 0;
  for (let i = values.length - period; i < values.length; i++) total += values[i];
  return total / period;
}

export function emaSeries(values: number[], period: number): (number | null)[] {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Mean dollar volume over the last `bars` closed bars: volume is in base units
// on every venue this bot trades, so volume x close is USD.
export function avgDollarVolume(candles: any[], bars: number = V3.adv_bars): number | null {
  if (candles.length < bars) return null;
  let total = 0;
  for (let i = candles.length - bars; i < candles.length; i++) {
    total += (candles[i].v || 0) * candles[i].c;
  }
  return total / bars;
}

// BTC's daily trend: close above the 200-day average. The gate the selection
// study found worth +0.48 points per trade on its own.
export function btcTrendUp(btcDaily: any[]): boolean {
  const bars = closedBars(btcDaily);
  if (bars.length < V3.sma_regime + 1) return false;
  const closes = bars.map((c) => c.c);
  const avg = smaLast(closes, V3.sma_regime);
  return avg != null && closes[closes.length - 1] > avg;
}

// The feed may or may not include the in-progress candle as its last element.
// Drop the last bar only when it is still forming, so a feed that already
// returns closed bars does not silently cost us a day of history.
export function closedBars(candles: any[], intervalMs: number = 86400000): any[] {
  if (!Array.isArray(candles) || candles.length < 2) return [];
  const last = candles[candles.length - 1];
  const t = Number(last && last.t);
  if (Number.isFinite(t) && t + intervalMs > Date.now()) return candles.slice(0, -1);
  return candles;
}

function shapeOf(bar: any) {
  const range = bar.h - bar.l;
  const body = Math.abs(bar.c - bar.o);
  if (range <= 0) return { range: 0, body: 0, bodyFrac: 0, upperFrac: 1, lowerFrac: 1, bull: bar.c > bar.o };
  return {
    range,
    body,
    bodyFrac: body / range,
    upperFrac: (bar.h - Math.max(bar.o, bar.c)) / range,
    lowerFrac: (Math.min(bar.o, bar.c) - bar.l) / range,
    bull: bar.c > bar.o,
  };
}

// The three daily bullish survivors from Gate 4, relaxed criteria: shape only,
// no preceding-trend requirement.
export function formationsAt(bars: any[], index: number, atr: (number | null)[]): string[] {
  const bar = bars[index];
  const value = Number(atr[index]);
  if (!bar || !(value > 0)) return [];
  const s = shapeOf(bar);
  const names: string[] = [];
  if (s.bull && s.body >= 1.0 * value) names.push("long_line_bull");
  if (s.bull && s.bodyFrac >= 0.9 && s.body >= 0.7 * value) names.push("marubozu_bull");
  if (s.bull && s.upperFrac <= 0.05 && s.body >= 0.5 * value) names.push("shaven_head_bull");
  return names;
}

// Any survivor formation on one of the last `window` closed bars.
export function confluenceAt(bars: any[], atr: (number | null)[], window: number = V3.confluence_window) {
  const names: string[] = [];
  for (let back = 1; back <= window; back++) {
    const index = bars.length - back;
    if (index < 0) break;
    for (const name of formationsAt(bars, index, atr)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return { hit: names.length > 0, names };
}

export function evaluateV3({ candles, btcAboveSma200 = false, minAdvUsd, profile }: {
  candles: any[];
  btcAboveSma200?: boolean;
  minAdvUsd?: number;
  profile?: string;
}) {
  const prof = v3Profile(profile);
  const advFloor = minAdvUsd != null ? minAdvUsd : prof.min_adv_usd;
  const bars = closedBars(candles);
  const empty = {
    state: "none",
    passed: false,
    atr: 0,
    horizon_bars: V3.horizon_bars,
    entry_signal: null,
    formations: [],
    gates: {
      history: false,
      entry_signal: false,
      liquidity: false,
      regime: btcAboveSma200 === true,
      confluence: false,
    },
    adv_usd: 0,
    reason: "not enough closed daily bars",
  };
  if (bars.length < V3.min_bars) return empty;

  const closes = bars.map((c) => c.c);
  const atr = atrSeries(bars);
  const last = bars.length - 1;
  const atrNow = Number(atr[last]);
  if (!(atrNow > 0)) return { ...empty, reason: "ATR unavailable" };

  // breakout, for every lookback the profile trades
  const breakouts = prof.breakout_bars.map((bars) => {
    const lookback = bars.slice(last - bars, last);
    const priorHigh = lookback.length ? Math.max(...lookback.map((c) => c.h)) : null;
    return priorHigh != null && closes[last] > priorHigh ? `breakout_${bars}` : null;
  }).filter(Boolean) as string[];

  // Keltner thrust: close above EMA20 + 2xATR, volume above its 20-bar average
  const ema = emaSeries(closes, V3.keltner_ema);
  const emaNow = ema[last];
  const volAvg = smaLast(bars.map((c) => c.v || 0), V3.adv_bars);
  const keltner =
    emaNow != null &&
    closes[last] > emaNow + V3.keltner_atr * atrNow &&
    volAvg != null &&
    (bars[last].v || 0) > volAvg;

  const entrySignal = [...breakouts, keltner ? "keltner_volume" : null].filter(Boolean) as string[];
  const adv = avgDollarVolume(bars, V3.adv_bars);
  const confluence = confluenceAt(bars, atr, V3.confluence_window);

  const gates = {
    history: true,
    entry_signal: entrySignal.length > 0,
    liquidity: adv != null && adv >= advFloor,
    // a gate the profile does not require reports true, so the reason chain
    // never blames a rule this profile switched off
    regime: prof.regime_required ? btcAboveSma200 === true : true,
    confluence: prof.confluence_required ? confluence.hit : true,
  };
  const passed = gates.entry_signal && gates.liquidity && gates.regime && gates.confluence;

  let reason = null;
  if (!passed) {
    if (!gates.entry_signal) reason = "No daily breakout or Keltner thrust on the last closed bar";
    else if (!gates.liquidity) reason = "Average daily dollar volume is below the $5m floor";
    else if (!gates.regime) reason = "BTC is below its 200-day average";
    else reason = "No survivor candle formation in the last 3 daily bars";
  }

  return {
    state: passed ? "entry" : "none",
    passed,
    atr: atrNow,
    horizon_bars: V3.horizon_bars,
    entry_signal: entrySignal,
    formations: confluence.names,
    gates,
    adv_usd: adv || 0,
    last_close: closes[last],
    bar_time: bars[last].t,
    reason,
  };
}

// The measured plan: a 2xATR stop and a 30-bar horizon, with no target.
export function v3Plan({ entryPx, atr }: { entryPx: number; atr: number }) {
  const px = Number(entryPx) || 0;
  const risk = V3.stop_atr * (Number(atr) || 0);
  if (!(px > 0) || !(risk > 0) || risk >= px) return null;
  return {
    stop: px - risk,
    risk_pct: (risk / px) * 100,
    horizon_bars: V3.horizon_bars,
    atr: Number(atr),
  };
}

// The exit check, run every cycle against the live price. A breached stop fills
// at its level — the same conservative fill the backtest assumes — and the
// horizon is counted in calendar days, which is what a 30-daily-bar hold means.
export function v3ExitDue({ trade, price, nowMs = Date.now() }: {
  trade: any;
  price: number;
  nowMs?: number;
}) {
  const stop = Number(trade.v3_stop ?? trade.stop_price) || 0;
  const horizon = Number(trade.v3_horizon_bars) || V3.horizon_bars;
  const openedMs = trade.opened_at ? Date.parse(trade.opened_at) : 0;
  const daysHeld = openedMs ? Math.floor((nowMs - openedMs) / 86400000) : 0;
  if (stop > 0 && price > 0 && price <= stop) {
    return { exit: true, reason: "stop", price: stop, days_held: daysHeld };
  }
  if (openedMs && daysHeld >= horizon) {
    return { exit: true, reason: "time", price, days_held: daysHeld };
  }
  return { exit: false, reason: null, price, days_held: daysHeld };
}
