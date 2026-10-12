import {
  ema,
  rsi,
  macd,
  bollinger,
  atr,
  adx,
  stochastic,
  obv,
  rollingVwap,
  bollingerWidth,
  pivots,
  swingTrend,
  resample,
  candlePattern,
  divergence,
  seriesChange,
  percentileRank,
} from "./indicators.ts";
import { fibRead, elliottRead, zoneRead, breakoutAge } from "./confluence.ts";
import { chartPattern } from "./patterns.ts";

const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
};
const opt = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : r2(v, d));

export function gradeFor(score) {
  if (score >= 85) return "A+";
  if (score >= 75) return "A";
  if (score >= 65) return "B";
  if (score >= 55) return "C";
  return "D";
}

export function verdictFor(score, side) {
  const isLong = side !== "short";
  if (score >= 82) return isLong ? "strong_long" : "strong_short";
  if (score >= 70) return isLong ? "long" : "short";
  if (score >= 58) return "watch";
  return "avoid";
}

function qualityFor(score, rr, confluence) {
  if (score >= 80 && rr >= 1.8 && confluence >= 5) return "A";
  if (score >= 70 && rr >= 1.6) return "B";
  if (score >= 60) return "C";
  return "D";
}

/**
 * Trade geometry. The stop sits behind the last swing but is clamped to a sane
 * ATR band, and the target must pay at least 1.6x the risk taken — a level ahead
 * can extend it, never shrink it below that floor.
 */
function levelsFor(dir, price, ctx) {
  const { atrVal, swingLow, swingHigh, resistance, support, fibTargets } = ctx;
  const minStop = 0.8 * atrVal;
  const maxStop = 2.4 * atrVal;
  let stop;
  let target;

  if (dir > 0) {
    const structural = swingLow - 0.2 * atrVal;
    stop = Math.min(Math.max(structural, price - maxStop), price - minStop);
    const unit = price - stop;
    target = price + 2 * unit;
    // a level ahead can set the target, but only inside a tradable 1.6R-3R band
    if (resistance && resistance > price) {
      const level = resistance * 1.004;
      if (level >= price + 1.6 * unit && level <= price + 3 * unit) target = level;
    } else {
      // Fibonacci extensions of the impulse leg can set the target too,
      // inside the same tradable band
      for (const fibLevel of fibTargets || []) {
        if (fibLevel >= price + 1.6 * unit && fibLevel <= price + 3 * unit) {
          target = fibLevel;
          break;
        }
      }
    }
  } else {
    const structural = swingHigh + 0.2 * atrVal;
    stop = Math.max(Math.min(structural, price + maxStop), price + minStop);
    const unit = stop - price;
    target = price - 2 * unit;
    if (support && support < price) {
      const level = support * 0.996;
      if (level <= price - 1.6 * unit && level >= price - 3 * unit) target = level;
    } else {
      for (const fibLevel of fibTargets || []) {
        if (fibLevel <= price - 1.6 * unit && fibLevel >= price - 3 * unit) {
          target = fibLevel;
          break;
        }
      }
    }
  }

  const stopPct = Math.abs(stop / price - 1) * 100;
  const requiredMovePct = Math.abs(target / price - 1) * 100;
  return {
    entry: price,
    stop,
    target,
    stopPct,
    requiredMovePct,
    rr: stopPct ? requiredMovePct / stopPct : 0,
  };
}

/**
 * The full read for one direction: five weighted desks — trend, momentum,
 * participation, location and tradability — scored from every tool available,
 * with the reasons behind the number and how many tools agree.
 */
function scoreSide(dir, m) {
  const up = dir > 0;
  const say = (long, short) => (up ? long : short);
  const reasons = [];
  const cats = { trend: 50, momentum: 50, volume: 50, location: 50, volatility: 50 };
  let confluence = 0;

  // ---- desk 1: trend and market structure
  let trend = 38;
  const stack = up
    ? [m.price > m.ema20, m.ema20 > m.ema50, m.ema200 == null || m.ema50 > m.ema200]
    : [m.price < m.ema20, m.ema20 < m.ema50, m.ema200 == null || m.ema50 < m.ema200];
  const stackCount = stack.filter(Boolean).length;
  trend += stackCount * 9;
  if (stackCount === 3) {
    reasons.push(say("Price, the 20 and the 50 averages are stacked in an uptrend", "Price, the 20 and the 50 averages are stacked in a downtrend"));
    confluence += 1;
  }
  if (up ? m.ema50Slope > 0.15 : m.ema50Slope < -0.15) {
    trend += 7;
    reasons.push(say(`The 50 average is rising (${r2(m.ema50Slope)}% over 10 bars)`, `The 50 average is falling (${r2(m.ema50Slope)}% over 10 bars)`));
    confluence += 1;
  } else if (up ? m.ema50Slope < -0.15 : m.ema50Slope > 0.15) {
    trend -= 12;
    reasons.push(say("The 50 average is still falling, against a long", "The 50 average is still rising, against a short"));
  }
  if (m.htfTrend === (up ? "up" : "down")) {
    trend += 10;
    reasons.push(say("The higher timeframe trend agrees — up", "The higher timeframe trend agrees — down"));
    confluence += 1;
  } else if (m.htfTrend === (up ? "down" : "up")) {
    trend -= 12;
    reasons.push(say("The higher timeframe trend still points down", "The higher timeframe trend still points up"));
  }
  if (m.structure === (up ? "up" : "down")) {
    trend += 8;
    reasons.push(say("Swing structure is printing higher highs and higher lows", "Swing structure is printing lower highs and lower lows"));
    confluence += 1;
  } else if (m.structure === (up ? "down" : "up")) {
    trend -= 10;
    reasons.push(say("Swing structure is still bearish", "Swing structure is still bullish"));
  }
  // simplified Elliott read: an early/mid impulse adds, a late five-wave
  // count subtracts (fresh entries chase the end of the move), a corrective
  // phase mildly supports the pending continuation, ambiguous counts score zero
  const ell = m.elliott;
  if (ell && ell.scenario === "impulse") {
    trend += 6;
    confluence += 1;
    reasons.push(say(`Elliott count reads an early impulse (${ell.waves} waves up)`, `Elliott count reads an early impulse (${ell.waves} waves down)`));
  } else if (ell && ell.scenario === "impulse_late") {
    trend -= 6;
    reasons.push(say("The wave count looks late-stage — fresh entries here chase the end of the move", "The wave count looks late-stage — fresh entries here chase the end of the move"));
  } else if (ell && ell.scenario === "corrective") {
    trend += 3;
  }
  const diOwned = up ? m.plusDi > m.minusDi : m.minusDi > m.plusDi;
  if (m.adx >= 25 && diOwned) {
    trend += 12;
    reasons.push(`ADX ${Math.round(m.adx)} confirms a trend with ${say("buyers", "sellers")} in control`);
    confluence += 1;
  } else if (m.adx >= 20 && diOwned) {
    trend += 6;
  } else if (m.adx < 15) {
    trend -= 8;
    reasons.push(`ADX ${Math.round(m.adx)} — the market is chopping sideways`);
  } else if (!diOwned) {
    trend -= 8;
  }
  cats.trend = clamp(Math.round(trend), 0, 100);

  // ---- desk 2: momentum
  let mom = 45;
  if (up) {
    if (m.rsi >= 50 && m.rsi <= 70) {
      mom += 14;
      reasons.push(`RSI ${Math.round(m.rsi)} is in the bullish momentum zone`);
      confluence += 1;
    } else if (m.rsi > 76) {
      mom -= 6;
      reasons.push(`RSI ${Math.round(m.rsi)} is overbought — chasing here is expensive`);
    } else if (m.rsi >= 42) {
      mom += 4;
    } else {
      mom -= 12;
      reasons.push(`RSI ${Math.round(m.rsi)} shows no buying pressure`);
    }
  } else {
    if (m.rsi <= 50 && m.rsi >= 30) {
      mom += 14;
      reasons.push(`RSI ${Math.round(m.rsi)} is in the bearish momentum zone`);
      confluence += 1;
    } else if (m.rsi < 24) {
      mom -= 6;
      reasons.push(`RSI ${Math.round(m.rsi)} is oversold — bounce risk`);
    } else if (m.rsi <= 58) {
      mom += 4;
    } else {
      mom -= 12;
      reasons.push(`RSI ${Math.round(m.rsi)} shows no selling pressure`);
    }
  }
  const rsiSlope = m.rsi - m.rsiPrev;
  if (up ? rsiSlope > 1 : rsiSlope < -1) confluence += 1;
  else if (up ? rsiSlope < -2 : rsiSlope > 2) mom -= 6;

  const relStrength = m.change24h * dir - m.median;
  if (relStrength > 2) {
    mom += 7;
    reasons.push(say("Outperforming the market over 24 hours", "Weaker than the market over 24 hours"));
    confluence += 1;
  } else if (relStrength < -2) {
    mom -= 7;
  }
  // regime tape: shorting a market that is broadly rising (or longing one
  // broadly falling) fights the median coin — the desk's history pays for that
  if (up ? m.median > 1.5 : m.median < -1.5) {
    mom -= 6;
    reasons.push(say("Most of the market is rising — shorts fight the tape", "Most of the market is falling — longs fight the tape"));
  }

  if (up ? m.hist > 0 : m.hist < 0) {
    mom += 8;
    reasons.push(say("MACD histogram is positive", "MACD histogram is negative"));
    confluence += 1;
  } else {
    mom -= 8;
  }
  if (up ? m.hist > m.histPrev : m.hist < m.histPrev) {
    mom += 6;
    confluence += 1;
  }
  if (up ? m.macd > m.signal : m.macd < m.signal) mom += 5;

  if (up) {
    if (m.stochK > m.stochD && m.stochK < 80) {
      mom += 8;
      reasons.push(`Stochastic ${Math.round(m.stochK)} is turning up`);
      confluence += 1;
    } else if (m.stochK > 85) {
      mom -= 6;
      reasons.push(`Stochastic ${Math.round(m.stochK)} is pinned overbought`);
    }
  } else {
    if (m.stochK < m.stochD && m.stochK > 20) {
      mom += 8;
      reasons.push(`Stochastic ${Math.round(m.stochK)} is turning down`);
      confluence += 1;
    } else if (m.stochK < 15) {
      mom -= 6;
      reasons.push(`Stochastic ${Math.round(m.stochK)} is pinned oversold`);
    }
  }

  if (m.div === (up ? "bullish" : "bearish")) {
    mom += 12;
    reasons.push(say("Bullish RSI divergence against the last swing low", "Bearish RSI divergence against the last swing high"));
    confluence += 1;
  } else if (m.div === (up ? "bearish" : "bullish")) {
    mom -= 10;
    reasons.push(say("Bearish RSI divergence — the uptrend is tiring", "Bullish RSI divergence — the downtrend is tiring"));
  }
  cats.momentum = clamp(Math.round(mom), 0, 100);

  // ---- desk 3: participation and volume flow
  let vol = 45;
  if (m.volRatio >= 1.5) {
    vol += 22;
    reasons.push(`Volume is ${r2(m.volRatio)}x its 20-bar average`);
    confluence += 1;
  } else if (m.volRatio >= 1.15) {
    vol += 12;
  } else if (m.volRatio < 0.7) {
    vol -= 10;
    reasons.push("Volume is drying up");
  }
  if (up ? m.obvChange > 2 : m.obvChange < -2) {
    vol += 14;
    reasons.push(say("On-balance volume is rising with price", "On-balance volume is falling with price"));
    confluence += 1;
  } else if (up ? m.obvChange < -2 : m.obvChange > 2) {
    vol -= 12;
    reasons.push("On-balance volume is moving against the trade");
  }
  if (m.vwapDistPct != null) {
    if (up ? m.vwapDistPct > 0 : m.vwapDistPct < 0) {
      vol += 10;
      confluence += 1;
    } else {
      vol -= 8;
    }
  }
  if (m.volRatio3 >= 1.3) vol += 6;
  cats.volume = clamp(Math.round(vol), 0, 100);

  // ---- desk 4: location of the entry. Fibonacci first: a pullback into the
  // golden pocket inside an established leg is the classic entry, and the
  // branches stay exclusive so nothing is double-counted.
  let loc = 42;
  const nearEma = Math.abs(m.price - m.ema20) / m.price < 0.015;
  const nearVwap = m.vwapDistPct != null && Math.abs(m.vwapDistPct) < 1;
  const fib = m.fib;
  if (fib && fib.phase && fib.phase !== "none" && fib.phase !== "breakout") {
    if (fib.phase === "golden") {
      loc += 16;
      confluence += 2;
      reasons.push("Fibonacci golden pocket: price sits in the 0.5-0.618 pullback of the last impulse leg");
    } else if (fib.phase === "shallow") {
      loc += 6;
      confluence += 1;
      reasons.push("Price is pulling back into the 0.236-0.382 Fibonacci zone");
    } else if (fib.phase === "deep") {
      loc += 4;
      reasons.push("Price is in a deep (0.618-0.786) Fibonacci pullback");
    } else if (fib.phase === "chasing") {
      loc -= 6;
      reasons.push(say("Price is past the last impulse high - the Fibonacci pullback entry is gone", "Price is past the last impulse low - the Fibonacci pullback entry is gone"));
    } else if (fib.phase === "broken") {
      loc -= 12;
      reasons.push("Price retraced beyond the 0.786 level - the impulse leg is invalidated");
    }
  } else if (m.breakout) {
    const stale = m.breakoutStale === true;
    loc += stale ? 4 : 14;
    reasons.push(
      stale
        ? say(
            `Broke out through ${m.breakoutLevel} ${m.breakoutAge} bars ago with no follow-through`,
            `Broke down through ${m.breakoutLevel} ${m.breakoutAge} bars ago with no follow-through`,
          )
        : say(`Breaking out above the last swing high at ${m.breakoutLevel}`, `Breaking down through the last swing low at ${m.breakoutLevel}`),
    );
    if (!stale) confluence += 1;
    if (m.volRatio >= 1.5 && !stale) {
      loc += 6;
      reasons.push("The breakout carries strong volume behind it");
    }
  } else if (nearEma && cats.trend >= 60) {
    loc += 18;
    reasons.push(say("Pullback into the 20 average inside an uptrend", "Bounce into the 20 average inside a downtrend"));
    confluence += 2;
  } else if (nearVwap && cats.trend >= 60) {
    loc += 14;
    reasons.push("Price is testing its volume-weighted average price");
    confluence += 1;
  }
  if (m.roomAhead >= 6) loc += 10;
  else if (m.roomAhead >= 3) loc += 5;
  else if (m.roomAhead < 1.5) {
    loc -= 14;
    reasons.push(say("A heavy ceiling sits just above price", "A heavy floor sits just below price"));
  }
  if (m.bbWidthPct <= 25) {
    loc += 8;
    reasons.push("Bollinger bands are squeezed — an expansion move is likely");
  } else if (m.bbWidthPct >= 92) {
    loc -= 6;
  }
  if (m.patternBias === (up ? "up" : "down")) {
    loc += 8;
    reasons.push(`${m.pattern} on the last candle`);
    confluence += 1;
  } else if (m.patternBias === (up ? "down" : "up")) {
    loc -= 6;
  }
  const stretch = (m.price / m.ema20 - 1) * 100 * dir;
  if (stretch > 12) {
    loc -= 14;
    reasons.push(say("Price is stretched far above the 20 average", "Price is stretched far below the 20 average"));
  } else if (stretch > 7) {
    loc -= 6;
  }
  // multi-touch zones: a retest of a level the market has respected before
  const zone = m.zones;
  if (zone && (up ? zone.at_support : zone.at_resistance)) {
    loc += 6;
    reasons.push(say("Price is retesting a multi-touch support zone", "Price is retesting a multi-touch resistance zone"));
    if (fib && fib.phase === "golden") {
      loc += 5;
      confluence += 1;
      reasons.push(say("Fibonacci level aligns with a multi-touch support zone", "Fibonacci level aligns with a multi-touch resistance zone"));
    }
  }
  cats.location = clamp(Math.round(loc), 0, 100);

  // ---- desk 5: tradability and the risk geometry
  let vlt = 55;
  if (m.atrPct >= 0.8 && m.atrPct <= 5) vlt += 15;
  else if (m.atrPct > 9) {
    vlt -= 18;
    reasons.push(`Volatility is extreme (ATR ${r2(m.atrPct)}% of price)`);
  } else if (m.atrPct < 0.45) {
    vlt -= 12;
    reasons.push(`Volatility is very low (ATR ${r2(m.atrPct)}%) — the move may not reach target`);
  }
  if (m.levels.rr >= 2.5) {
    vlt += 14;
    confluence += 1;
  } else if (m.levels.rr >= 1.8) vlt += 8;
  else if (m.levels.rr < 1.6) {
    vlt -= 18;
    reasons.push(`Risk/reward of ${r2(m.levels.rr, 1)}:1 is too thin`);
  }
  if (m.requiredMovePct > 12) {
    vlt -= 12;
    reasons.push(`Target needs a ${Math.round(m.requiredMovePct)}% move — a stretch for one session`);
  }
  if (m.volume24h < 250000) vlt -= 8;
  if (m.change24h * dir > 30) {
    vlt -= 10;
    reasons.unshift(
      say(
        `Vertical ${Math.round(m.change24h)}% day — chasing this is high risk`,
        `Crashed ${Math.round(Math.abs(m.change24h))}% in a day — bounce risk is high`,
      ),
    );
  }
  cats.volatility = clamp(Math.round(vlt), 0, 100);

  const score = clamp(
    Math.round(
      cats.trend * 0.3 +
        cats.momentum * 0.22 +
        cats.volume * 0.19 +
        cats.location * 0.19 +
        cats.volatility * 0.1,
    ),
    0,
    100,
  );

  return { score, reasons: reasons.slice(0, 6), categories: cats, confluence };
}

/**
 * Scores one coin on one timeframe for both directions and returns the setup
 * with the entry, target, stop and the reasons behind the ranking.
 */
export function analyzeCoin(coin, candles, ctx = {}) {
  const closes = candles.map((c) => c.c);
  const n = closes.length;
  if (n < 80) return null;
  const price = closes[n - 1];
  if (!price) return null;

  const ema20s = ema(closes, 20);
  const ema50s = ema(closes, 50);
  const ema200s = ema(closes, 200);
  const rsiSeries = rsi(closes, 14);
  const macdRes = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const atrSeries = atr(candles, 14);
  const adxRes = adx(candles, 14);
  const stochRes = stochastic(candles, 14, 3, 3);
  const obvSeries = obv(candles);
  const bbwSeries = bollingerWidth(closes, 20, 2);

  const ema20 = last(ema20s) ?? price;
  const ema50 = last(ema50s) ?? price;
  const ema200 = last(ema200s);
  const rsiVal = last(rsiSeries) ?? 50;
  const rsiPrev = rsiSeries[n - 4] ?? rsiVal;
  const macdVal = last(macdRes.macd) ?? 0;
  const signalVal = last(macdRes.signal) ?? 0;
  const histVal = last(macdRes.hist) ?? 0;
  const histPrev = macdRes.hist[n - 3] ?? 0;
  const histPrev3 = macdRes.hist[n - 4] ?? 0;
  const bbUpper = last(bb.upper);
  const bbLower = last(bb.lower);
  const atrVal = Math.max(last(atrSeries) ?? price * 0.02, price * 0.002);
  const atrPct = (atrVal / price) * 100;
  const adxVal = last(adxRes.adx) ?? 0;
  const plusDi = last(adxRes.plusDi) ?? 0;
  const minusDi = last(adxRes.minusDi) ?? 0;
  const stochK = last(stochRes.k) ?? 50;
  const stochD = last(stochRes.d) ?? 50;
  const obvChange = seriesChange(obvSeries, 10);
  const bbWidth = last(bbwSeries);
  const bbWidthPct = percentileRank(bbwSeries.slice(-120), bbWidth);

  const barsPerDay = Number(ctx.barsPerDay) || 24;
  const vwapPeriod = barsPerDay >= 24 ? barsPerDay : 20;
  const vwapSeries = rollingVwap(candles, Math.min(vwapPeriod, Math.max(12, n - 5)));
  const vwapVal = last(vwapSeries);
  const vwapDistPct = vwapVal ? ((price - vwapVal) / vwapVal) * 100 : null;

  // ---- swing structure and the levels that matter
  const pivotList = pivots(candles, 2).filter((p) => p.i >= n - 90);
  const structure = swingTrend(pivotList);
  const swingHighs = pivotList.filter((p) => p.kind === "high");
  const swingLows = pivotList.filter((p) => p.kind === "low");
  const lastSwingHigh = swingHighs.length
    ? swingHighs[swingHighs.length - 1].price
    : Math.max(...candles.slice(-10).map((c) => c.h));
  const lastSwingLow = swingLows.length
    ? swingLows[swingLows.length - 1].price
    : Math.min(...candles.slice(-10).map((c) => c.l));

  const highsAbove = swingHighs.filter((p) => p.price > price * 1.002).map((p) => p.price);
  const lowsBelow = swingLows.filter((p) => p.price < price * 0.998).map((p) => p.price);
  const resistance = highsAbove.length
    ? Math.min(...highsAbove)
    : Math.max(...candles.slice(-60).map((c) => c.h));
  const support = lowsBelow.length
    ? Math.max(...lowsBelow)
    : Math.min(...candles.slice(-40).map((c) => c.l));
  const roomUpPct = resistance > price ? ((resistance - price) / price) * 100 : 0;
  const roomDownPct = support < price ? ((price - support) / price) * 100 : 0;

  // ---- higher timeframe confirmation (4x the working timeframe)
  const htf = resample(candles, 4);
  const htfCloses = htf.map((c) => c.c);
  const htfEma20 = last(ema(htfCloses, 20));
  const htfEma50 = last(ema(htfCloses, 50));
  const htfLast = htfCloses[htfCloses.length - 1];
  const htfTrend =
    htfEma20 == null || htfEma50 == null || htfCloses.length < 60
      ? "unknown"
      : htfLast > htfEma20 && htfEma20 > htfEma50
        ? "up"
        : htfLast < htfEma20 && htfEma20 < htfEma50
          ? "down"
          : "range";

  const win20 = candles.slice(-20);
  const volAvg = win20.reduce((a, c) => a + (c.v || 0), 0) / win20.length;
  const volRatio = volAvg ? (candles[n - 1].v || 0) / volAvg : 1;
  const volRatio3 = volAvg
    ? candles.slice(-3).reduce((a, c) => a + (c.v || 0), 0) / 3 / volAvg
    : 1;
  const ema50Slope = ((ema50 - (ema50s[n - 11] ?? ema50)) / ema50) * 100;
  const pattern = candlePattern(candles);
  const div = divergence(pivotList, rsiSeries);
  // classic swing-chart patterns (double/triple tops and bottoms, head and
  // shoulders, diamonds, triangles, wedges, cups, flags) — gate-level input
  const chart = chartPattern(pivotList, candles, price);

  const change24h = Number(coin.change24h) || 0;
  const barsAgo = Math.min(n - 2, Math.max(1, Math.round(barsPerDay * 7)));
  const weekAgo = closes[n - 1 - barsAgo];
  const change7d = weekAgo ? (price / weekAgo - 1) * 100 : Number(coin.change7d) || 0;
  const median = Number(ctx.medianChange24h) || 0;
  const dailyTarget = Number(ctx.dailyTargetPct) || 2;

  // structural confluence (Fibonacci legs, Elliott counts, S/R zones). The v2
  // engine runs unless config turns it off, or a backtest asks for the legacy read.
  const engineV2 = ctx.confluenceV2 !== false && ctx.legacy !== true;
  const fibLong = engineV2 ? fibRead(pivotList, price, 1) : null;
  const fibShort = engineV2 ? fibRead(pivotList, price, -1) : null;
  const ellLong = engineV2 ? elliottRead(pivotList, 1) : null;
  const ellShort = engineV2 ? elliottRead(pivotList, -1) : null;
  const zones = engineV2 ? zoneRead(pivotList, price) : null;
  const ageLong = engineV2 && price > lastSwingHigh * 1.002 ? breakoutAge(candles, lastSwingHigh, 1) : 0;
  const ageShort = engineV2 && price < lastSwingLow * 0.998 ? breakoutAge(candles, lastSwingLow, -1) : 0;

  const levelCtx = { atrVal, swingLow: lastSwingLow, swingHigh: lastSwingHigh, resistance, support };
  const longLevels = levelsFor(1, price, {
    ...levelCtx,
    fibTargets: engineV2 && fibLong ? fibLong.targets : [],
  });
  const shortLevels = levelsFor(-1, price, {
    ...levelCtx,
    fibTargets: engineV2 && fibShort ? fibShort.targets : [],
  });

  const shared = {
    price,
    ema20,
    ema50,
    ema200,
    ema50Slope,
    rsi: rsiVal,
    rsiPrev,
    macd: macdVal,
    signal: signalVal,
    hist: histVal,
    histPrev,
    stochK,
    stochD,
    adx: adxVal,
    plusDi,
    minusDi,
    volRatio,
    volRatio3,
    obvChange,
    vwapDistPct,
    bbWidthPct,
    structure,
    htfTrend,
    pattern: pattern.name,
    patternBias: pattern.bias,
    div: div.kind,
    atrPct,
    change24h,
    change7d,
    median,
    volume24h: Number(coin.volume24h) || 0,
  };

  const longRead = scoreSide(1, {
    ...shared,
    levels: longLevels,
    requiredMovePct: longLevels.requiredMovePct,
    roomAhead: roomUpPct,
    breakout: price > lastSwingHigh * 1.002,
    breakoutLevel: r2(lastSwingHigh, 6),
    fib: fibLong,
    elliott: ellLong,
    zones,
    breakoutStale: ageLong > 12,
    breakoutAge: ageLong,
  });
  const shortRead = scoreSide(-1, {
    ...shared,
    levels: shortLevels,
    requiredMovePct: shortLevels.requiredMovePct,
    roomAhead: roomDownPct,
    breakout: price < lastSwingLow * 0.998,
    breakoutLevel: r2(lastSwingLow, 6),
    fib: fibShort,
    elliott: ellShort,
    zones,
    breakoutStale: ageShort > 12,
    breakoutAge: ageShort,
  });

  const side = longRead.score >= shortRead.score ? "long" : "short";
  const chosen = side === "long" ? longRead : shortRead;
  const levels = side === "long" ? longLevels : shortLevels;
  const score = chosen.score;
  const roomPct = side === "long" ? roomUpPct : roomDownPct;

  const trendAligned = side === "long" ? structure === "up" || htfTrend === "up" : structure === "down" || htfTrend === "down";
  const confidence = clamp(
    Math.round(
      score * 0.62 +
        Math.min(chosen.confluence, 8) * 3.2 +
        (levels.rr >= 2 ? 8 : levels.rr >= 1.6 ? 4 : 0) +
        (trendAligned ? 5 : 0) +
        (volRatio >= 1.3 ? 3 : 0),
    ),
    15,
    97,
  );

  // conviction of the signal bar: body as a share of its full range (combo gate)
  const lastCandle = candles[candles.length - 1];
  const bodyRatio =
    lastCandle && lastCandle.h > lastCandle.l
      ? Math.abs(lastCandle.c - lastCandle.o) / (lastCandle.h - lastCandle.l)
      : 0;
  return {
    body_ratio: r2(bodyRatio),
    symbol: coin.symbol,
    name: coin.name,
    coingecko_id: coin.coingecko_id || "",
    image: coin.image || "",
    price: r2(price, 6),
    market_cap: coin.market_cap || 0,
    market_cap_bucket: coin.bucket || bucketFor(coin.market_cap),
    volume24h: coin.volume24h || 0,
    change24h: r2(change24h),
    change7d: r2(change7d),
    side,
    score,
    long_score: longRead.score,
    short_score: shortRead.score,
    grade: gradeFor(score),
    verdict: verdictFor(score, side),
    confidence,
    quality: qualityFor(score, levels.rr, chosen.confluence),
    confluence: Math.min(chosen.confluence, 8),
    entry: r2(levels.entry, 6),
    target: r2(levels.target, 6),
    stop: r2(levels.stop, 6),
    required_move_pct: r2(levels.requiredMovePct),
    stop_pct: r2(levels.stopPct),
    risk_reward: r2(levels.rr, 1),
    room_pct: r2(roomPct),
    structure,
    htf_trend: htfTrend,
    pattern: pattern.name,
    pattern_bias: pattern.bias,
    chart_pattern: chart.name,
    chart_pattern_bias: chart.bias,
    chart_pattern_quality: chart.quality,
    rsi_divergence: div.kind,
    fib_phase: chosen.fib && chosen.fib.phase !== "none" ? chosen.fib.phase : null,
    elliott: chosen.elliott && chosen.elliott.scenario ? chosen.elliott.scenario : null,
    categories: chosen.categories,
    meets_daily_target: levels.requiredMovePct >= dailyTarget && score >= 58,
    reasons: chosen.reasons,
    indicators: {
      rsi: r2(rsiVal, 1),
      macd: r2(macdVal, 5),
      macd_signal: r2(signalVal, 5),
      macd_hist: r2(histVal, 5),
      ema20: r2(ema20, 6),
      ema50: r2(ema50, 6),
      ema200: ema200 == null ? null : r2(ema200, 6),
      bb_upper: bbUpper == null ? null : r2(bbUpper, 6),
      bb_lower: bbLower == null ? null : r2(bbLower, 6),
      bb_width_pct: opt(bbWidth, 3),
      bb_width_percentile: bbWidthPct,
      atr: r2(atrVal, 6),
      atr_pct: r2(atrPct),
      adx: r2(adxVal, 1),
      plus_di: r2(plusDi, 1),
      minus_di: r2(minusDi, 1),
      stoch_k: r2(stochK, 1),
      stoch_d: r2(stochD, 1),
      obv_change_pct: r2(obvChange, 1),
      vwap: vwapVal == null ? null : r2(vwapVal, 6),
      vwap_dist_pct: vwapDistPct == null ? null : r2(vwapDistPct),
      vol_ratio: r2(volRatio),
      vol_ratio_3: r2(volRatio3),
      ema50_slope: r2(ema50Slope),
      swing_high: r2(lastSwingHigh, 6),
      swing_low: r2(lastSwingLow, 6),
      support: support == null ? null : r2(support, 6),
      resistance: resistance == null ? null : r2(resistance, 6),
      trend:
        price > ema50 && (ema200 == null || ema50 > ema200)
          ? "up"
          : price < ema50 && (ema200 == null || ema50 < ema200)
            ? "down"
            : "sideways",
      structure,
      htf_trend: htfTrend,
      pattern: pattern.name,
      rsi_divergence: div.kind,
      fib:
        chosen.fib && chosen.fib.phase !== "none"
          ? {
              phase: chosen.fib.phase,
              retracement: chosen.fib.retracement == null ? null : r2(chosen.fib.retracement, 3),
              leg_pct: r2(chosen.fib.move_pct, 1),
              targets: (chosen.fib.targets || []).map((t) => r2(t, 6)),
            }
          : null,
      elliott: chosen.elliott && chosen.elliott.scenario ? chosen.elliott.scenario : null,
      zones: zones
        ? {
            strong_support: zones.strong_support == null ? null : r2(zones.strong_support, 6),
            strong_resistance: zones.strong_resistance == null ? null : r2(zones.strong_resistance, 6),
          }
        : null,
    },
  };
}

function bucketFor(marketCap) {
  const cap = Number(marketCap) || 0;
  if (cap >= 10e9) return "large";
  if (cap >= 1e9) return "mid";
  if (cap >= 100e6) return "small";
  return "micro";
}