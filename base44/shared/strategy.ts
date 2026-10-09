import { ema, rsi, macd, bollinger, atr } from "./indicators.ts";

const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
};

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

function levelsFor(side, price, ctx) {
  const { atrVal, low20, high20, resistance, support } = ctx;
  const rrTarget = 2.5;
  let stop;
  let target;

  if (side === "long") {
    stop = Math.max(low20, price - 1.8 * atrVal);
    if (price - stop < 1.2 * atrVal) stop = price - 1.2 * atrVal;
    stop = Math.min(stop, price * 0.995);
    target = price + rrTarget * (price - stop);
    if (resistance && resistance > price && resistance < target) {
      target = resistance * 1.015;
    }
  } else {
    stop = Math.min(high20, price + 1.8 * atrVal);
    if (stop - price < 1.2 * atrVal) stop = price + 1.2 * atrVal;
    stop = Math.max(stop, price * 1.005);
    target = price - rrTarget * (stop - price);
    if (support && support < price && support > target) target = support * 0.985;
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

  const ema20 = last(ema20s) ?? price;
  const ema50 = last(ema50s) ?? price;
  const ema200 = last(ema200s);
  const rsiVal = last(rsiSeries) ?? 50;
  const macdVal = last(macdRes.macd) ?? 0;
  const signalVal = last(macdRes.signal) ?? 0;
  const histVal = last(macdRes.hist) ?? 0;
  const histPrev3 = macdRes.hist[n - 4] ?? 0;
  const bbUpper = last(bb.upper);
  const bbLower = last(bb.lower);
  const atrVal = last(atrSeries) ?? price * 0.02;
  const atrPct = (atrVal / price) * 100;

  const win20 = candles.slice(-20);
  const win40 = candles.slice(-40);
  const win60 = candles.slice(-60);
  const low20 = Math.min(...win20.map((c) => c.l));
  const high20 = Math.max(...win20.map((c) => c.h));
  const above = win60.filter((c) => c.h > price).map((c) => c.h);
  const below = win40.filter((c) => c.l < price).map((c) => c.l);
  const resistance = above.length ? Math.min(...above) : null;
  const support = below.length ? Math.max(...below) : null;
  const volAvg = win20.reduce((a, c) => a + c.v, 0) / win20.length;
  const volRatio = volAvg ? candles[n - 1].v / volAvg : 1;
  const ema50Slope = ((ema50 - (ema50s[n - 11] ?? ema50)) / ema50) * 100;

  const change24h = Number(coin.change24h) || 0;
  const barsPerDay = Number(ctx.barsPerDay) || 24;
  const barsAgo = Math.min(n - 2, Math.max(1, Math.round(barsPerDay * 7)));
  const weekAgo = closes[n - 1 - barsAgo];
  const change7d = weekAgo ? (price / weekAgo - 1) * 100 : Number(coin.change7d) || 0;
  const median = Number(ctx.medianChange24h) || 0;
  const dailyTarget = Number(ctx.dailyTargetPct) || 2;

  const upTrend = price > ema50 && (ema200 == null || ema50 > ema200);
  const downTrend = price < ema50 && (ema200 == null || ema50 < ema200);
  const nearEma20 = Math.abs(price - ema20) / price < 0.02;

  // ---- long score
  const longReasons = [];
  let longScore = 0;
  if (price > ema50) {
    longScore += 8;
    longReasons.push("Price is above the 50-period average");
  }
  if (ema200 == null || ema50 > ema200) {
    longScore += 8;
    if (ema200 != null) longReasons.push("50 average is above the 200 average");
  }
  if (ema50Slope > 0.2) {
    longScore += 5;
    longReasons.push("Trend slope is rising");
  }
  if (price > ema20) longScore += 4;
  if (rsiVal >= 50 && rsiVal <= 72) {
    longScore += 10;
    longReasons.push(`RSI ${Math.round(rsiVal)} sits in the momentum zone`);
  } else if (rsiVal > 78) {
    longReasons.push(`RSI ${Math.round(rsiVal)} is overbought`);
  } else if (rsiVal >= 45) {
    longScore += 5;
  }
  if (histVal > 0) {
    longScore += 6;
    longReasons.push("MACD momentum is positive");
  }
  if (histVal > histPrev3) longScore += 4;
  if (change24h > 0) longScore += 6;
  if (change24h > median) {
    longScore += 5;
    longReasons.push("Outperforming the market today");
  }
  if (change7d > 0) longScore += 4;
  if (volRatio >= 1.5) {
    longScore += 15;
    longReasons.push("Volume well above its average");
  } else if (volRatio >= 1.2) longScore += 11;
  else if (volRatio >= 1) longScore += 7;
  else longScore += 3;
  if (upTrend && nearEma20) {
    longScore += 12;
    longReasons.push("Pullback into the 20 average inside an uptrend");
  } else if (bbUpper && price > bbUpper && volRatio >= 1.2) {
    longScore += 11;
    longReasons.push("Breaking above the upper band on volume");
  } else if (bbUpper && price > bbUpper * 1.03) {
    longReasons.push("Extended above the upper band");
  } else {
    longScore += 4;
  }
  longScore += atrPct >= 0.6 && atrPct <= 6 ? 6 : 2;
  if (!resistance || (resistance - price) / price > 0.02) longScore += 4;
  if (change24h > 35) {
    longScore -= 12;
    longReasons.unshift(`Vertical ${Math.round(change24h)}% day - chasing this is high risk`);
  }
  if (price > ema20 * 1.15) {
    longScore -= 8;
    longReasons.push("Stretched far above its 20 average");
  }
  longScore = clamp(Math.round(longScore), 0, 100);

  // ---- short score
  const shortReasons = [];
  let shortScore = 0;
  if (price < ema50) {
    shortScore += 8;
    shortReasons.push("Price is below the 50-period average");
  }
  if (ema200 == null || ema50 < ema200) {
    shortScore += 8;
    if (ema200 != null) shortReasons.push("50 average is below the 200 average");
  }
  if (ema50Slope < -0.2) {
    shortScore += 5;
    shortReasons.push("Trend slope is falling");
  }
  if (price < ema20) shortScore += 4;
  if (rsiVal <= 50 && rsiVal >= 28) {
    shortScore += 10;
    shortReasons.push(`RSI ${Math.round(rsiVal)} shows weak momentum`);
  } else if (rsiVal < 22) {
    shortReasons.push(`RSI ${Math.round(rsiVal)} is oversold`);
  } else if (rsiVal <= 55) {
    shortScore += 5;
  }
  if (histVal < 0) {
    shortScore += 6;
    shortReasons.push("MACD momentum is negative");
  }
  if (histVal < histPrev3) shortScore += 4;
  if (change24h < 0) shortScore += 6;
  if (change24h < median) shortScore += 5;
  if (change7d < 0) shortScore += 4;
  if (volRatio >= 1.5) {
    shortScore += 15;
    shortReasons.push("Heavy volume behind the move down");
  } else if (volRatio >= 1.2) shortScore += 11;
  else if (volRatio >= 1) shortScore += 7;
  else shortScore += 3;
  if (downTrend && nearEma20) {
    shortScore += 12;
    shortReasons.push("Bounce into the 20 average inside a downtrend");
  } else if (bbLower && price < bbLower && volRatio >= 1.2) {
    shortScore += 11;
    shortReasons.push("Breaking below the lower band on volume");
  } else if (bbLower && price < bbLower * 0.97) {
    shortReasons.push("Extended below the lower band");
  } else {
    shortScore += 4;
  }
  shortScore += atrPct >= 0.6 && atrPct <= 6 ? 6 : 2;
  if (!support || (price - support) / price > 0.02) shortScore += 4;
  if (change24h < -35) {
    shortScore -= 12;
    shortReasons.unshift(`Crashed ${Math.round(change24h)}% in a day - bounce risk is high`);
  }
  if (price < ema20 * 0.87) {
    shortScore -= 8;
    shortReasons.push("Stretched far below its 20 average");
  }
  shortScore = clamp(Math.round(shortScore), 0, 100);

  const side = longScore >= shortScore ? "long" : "short";
  const score = Math.max(longScore, shortScore);
  const reasons = (side === "long" ? longReasons : shortReasons).slice(0, 5);
  const levels = levelsFor(side, price, {
    atrVal,
    low20,
    high20,
    resistance: resistance ?? null,
    support: support ?? null,
  });

  const trendAligned = side === "long" ? upTrend : downTrend;
  const confidence = clamp(
    Math.round(
      score * 0.82 +
        (volRatio > 1.3 ? 8 : 0) +
        (levels.rr >= 2 ? 6 : 0) +
        (trendAligned ? 4 : 0),
    ),
    20,
    96,
  );

  return {
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
    long_score: longScore,
    short_score: shortScore,
    grade: gradeFor(score),
    verdict: verdictFor(score, side),
    confidence,
    entry: r2(levels.entry, 6),
    target: r2(levels.target, 6),
    stop: r2(levels.stop, 6),
    required_move_pct: r2(levels.requiredMovePct),
    stop_pct: r2(levels.stopPct),
    risk_reward: r2(levels.rr, 2),
    meets_daily_target: levels.requiredMovePct >= dailyTarget && score >= 58,
    reasons,
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
      atr_pct: r2(atrPct),
      vol_ratio: r2(volRatio),
      ema50_slope: r2(ema50Slope),
      support: support == null ? null : r2(support, 6),
      resistance: resistance == null ? null : r2(resistance, 6),
      trend: upTrend ? "up" : downTrend ? "down" : "sideways",
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