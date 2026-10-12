// Chart-pattern recognition for the signal engine: the classic swing patterns
// read off the alternating pivot sequence, plus a consolidation-flag detector
// on the raw candles. Every detector is conservative — an ambiguous or thin
// shape returns "none"/neutral so the pattern desk never blocks a clean setup.

/** Alternating swing sequence: consecutive same-kind pivots collapse to the extreme. */
function swingSeq(pivotList) {
  const seq = [];
  for (const p of pivotList) {
    const prev = seq[seq.length - 1];
    if (prev && prev.kind === p.kind) {
      if ((p.kind === "high" && p.price > prev.price) || (p.kind === "low" && p.price < prev.price)) {
        seq[seq.length - 1] = p;
      }
    } else {
      seq.push(p);
    }
  }
  return seq;
}

// double top / bottom: two swing extremes within tolerance, separated by an
// intervening opposite swing at least 1.5% away (the neckline)
function doubleExtreme(seq, price) {
  const tol = price * 0.02;
  const lows = seq.filter((p) => p.kind === "low");
  const highs = seq.filter((p) => p.kind === "high");
  const build = (extremes, kind) => {
    if (extremes.length < 2) return null;
    const second = extremes[extremes.length - 1];
    const first = extremes[extremes.length - 2];
    if (Math.abs(first.price - second.price) > tol) return null;
    const between = seq.filter((p) => p.i > first.i && p.i < second.i && p.kind !== kind);
    const neck = between.length ? Math.max(...between.map((p) => p.price)) : null;
    if (!neck || neck < Math.max(first.price, second.price) * 1.015) return null;
    const confirmed = kind === "low" ? price > neck : price < neck;
    return {
      name: kind === "low" ? "double bottom" : "double top",
      bias: kind === "low" ? "bullish" : "bearish",
      quality: confirmed ? 3 : 2,
      recency: second.i,
    };
  };
  return build(lows, "low") || build(highs, "high");
}

// triple top / bottom: three swing extremes within a tight band
function tripleExtreme(seq, price) {
  const tol = price * 0.018;
  const build = (extremes, kind) => {
    if (extremes.length < 3) return null;
    const [a, b, c] = extremes.slice(-3);
    const top = Math.max(a.price, b.price, c.price);
    const bottom = Math.min(a.price, b.price, c.price);
    if (top - bottom > tol) return null;
    const between = seq.filter((p) => p.i > a.i && p.i < c.i && p.kind !== kind);
    const neck = between.length ? Math.max(...between.map((p) => p.price)) : null;
    if (!neck || neck < top * 1.015) return null;
    const confirmed = kind === "low" ? price > neck : price < neck;
    return {
      name: kind === "low" ? "triple bottom" : "triple top",
      bias: kind === "low" ? "bullish" : "bearish",
      quality: confirmed ? 4 : 3,
      recency: c.i,
    };
  };
  return (
    build(seq.filter((p) => p.kind === "low"), "low") ||
    build(seq.filter((p) => p.kind === "high"), "high")
  );
}

// head & shoulders (three highs, middle highest) and its inverse
function headShoulders(seq, price) {
  const tol = price * 0.03;
  const build = (extremes, kind) => {
    if (extremes.length < 3) return null;
    const [s1, head, s2] = extremes.slice(-3);
    if (s2.i - s1.i < 6) return null;
    if (kind === "high") {
      if (!(head.price > s1.price && head.price > s2.price)) return null;
      if (Math.abs(s1.price - s2.price) > tol) return null;
      const lows = seq.filter((p) => p.i > s1.i && p.i < s2.i && p.kind === "low");
      const neck = lows.length ? Math.min(...lows.map((p) => p.price)) : null;
      if (!neck) return null;
      return {
        name: "head and shoulders",
        bias: "bearish",
        quality: price < neck ? 3 : 2,
        recency: s2.i,
      };
    }
    if (!(head.price < s1.price && head.price < s2.price)) return null;
    if (Math.abs(s1.price - s2.price) > tol) return null;
    const highs = seq.filter((p) => p.i > s1.i && p.i < s2.i && p.kind === "high");
    const neck = highs.length ? Math.max(...highs.map((p) => p.price)) : null;
    if (!neck) return null;
    return {
      name: "inverse head and shoulders",
      bias: "bullish",
      quality: price > neck ? 3 : 2,
      recency: s2.i,
    };
  };
  return (
    build(seq.filter((p) => p.kind === "high"), "high") ||
    build(seq.filter((p) => p.kind === "low"), "low")
  );
}

// diamond top / bottom: swings expand for at least two steps, then contract for
// two — the widening-then-narrowing range. Which one is read from where the
// window's extreme sits: at a high near the middle it is a topping diamond,
// at a low near the middle a bottoming one.
function diamond(seq, price) {
  const swings = [];
  for (let i = 1; i < seq.length; i++) {
    swings.push({ amp: Math.abs(seq[i].price - seq[i - 1].price), dir: seq[i].price > seq[i - 1].price });
  }
  const w = swings.slice(-5);
  if (w.length < 5) return null;
  const grows = w[1].amp >= w[0].amp * 1.15 && w[2].amp >= w[1].amp * 1.15;
  const shrinks = w[3].amp <= w[2].amp * 0.85 && w[4].amp <= w[3].amp * 0.85;
  if (!grows || !shrinks) return null;
  const window = seq.slice(-6);
  const windowHigh = window.reduce((m, p) => (p.price > m ? p.price : m), 0);
  const windowLow = window.reduce((m, p) => (p.price < m ? p.price : m), Infinity);
  const midHigh = Math.max(...window.slice(1, 5).filter((p) => p.kind === "high").map((p) => p.price), 0);
  const midLow = Math.min(...window.slice(1, 5).filter((p) => p.kind === "low").map((p) => p.price), Infinity);
  if (midHigh >= windowHigh * 0.999 && midHigh > windowLow) {
    return { name: "diamond top", bias: "bearish", quality: 2, recency: seq[seq.length - 1].i };
  }
  if (midLow <= windowLow * 1.001 && midLow < windowHigh) {
    return { name: "diamond bottom", bias: "bullish", quality: 2, recency: seq[seq.length - 1].i };
  }
  return null;
}

// triangles and wedges: slopes of the last two highs and lows, per bar, in %
function wedgeTriangle(seq, price) {
  const highs = seq.filter((p) => p.kind === "high");
  const lows = seq.filter((p) => p.kind === "low");
  if (highs.length < 3 || lows.length < 3) return null;
  const slope = (a, b) => ((b.price - a.price) / a.price) * 100 / Math.max(1, b.i - a.i);
  const sH = slope(highs[highs.length - 2], highs[highs.length - 1]);
  const sL = slope(lows[lows.length - 2], lows[lows.length - 1]);
  const flat = 0.02;
  const recency = seq[seq.length - 1].i;
  if (Math.abs(sH) < flat && sL > flat)
    return { name: "ascending triangle", bias: "bullish", quality: 3, recency };
  if (sH < -flat && Math.abs(sL) < flat)
    return { name: "descending triangle", bias: "bearish", quality: 3, recency };
  if (sH < -flat && sL > flat)
    return { name: "symmetrical triangle", bias: "neutral", quality: 2, recency };
  if (sH > 0 && sL > sH)
    return { name: "rising wedge", bias: "bearish", quality: 2, recency };
  if (sH < 0 && sL < sH)
    return { name: "falling wedge", bias: "bullish", quality: 2, recency };
  return null;
}

// cup & handle / rounding bottom: a U of lows with matching rims and price back
// near the rim
function cupHandle(seq, price) {
  const lows = seq.filter((p) => p.kind === "low");
  if (lows.length < 3) return null;
  const window = lows.slice(-4);
  const first = window[0];
  const last = window[window.length - 1];
  const middle = window.slice(1, -1);
  if (!middle.length) return null;
  const bottom = Math.min(...middle.map((p) => p.price), ...window.slice(1, -1).map((p) => p.price));
  const tol = price * 0.03;
  const depth = (first.price - bottom) / first.price;
  if (
    Math.abs(first.price - last.price) <= tol &&
    depth >= 0.04 &&
    price >= bottom * 1.06 &&
    price >= first.price * 0.97
  ) {
    return { name: "cup and handle", bias: "bullish", quality: 2, recency: last.i };
  }
  return null;
}

// bull/bear flag: a sharp pole followed by a tight consolidation
function flagPattern(candles, price) {
  const n = candles.length;
  if (n < 30) return null;
  const pole = ((candles[n - 11].c - candles[n - 21].c) / candles[n - 21].c) * 100;
  if (Math.abs(pole) < 8) return null;
  const box = candles.slice(-10);
  const hi = Math.max(...box.map((c) => c.h));
  const lo = Math.min(...box.map((c) => c.l));
  if ((hi - lo) / price > 0.035) return null;
  return {
    name: pole > 0 ? "bull flag" : "bear flag",
    bias: pole > 0 ? "bullish" : "bearish",
    quality: 2,
    recency: n - 1,
  };
}

/**
 * The most significant chart pattern on the current swing structure: the
 * highest-quality, most recent detection wins. Returns
 * {name, bias: bullish|bearish|neutral, quality: 0-4, recency}.
 */
export function chartPattern(pivotList, candles, price) {
  const seq = swingSeq(pivotList);
  if (seq.length >= 4) {
    const found = [
      tripleExtreme(seq, price),
      headShoulders(seq, price),
      doubleExtreme(seq, price),
      diamond(seq, price),
      wedgeTriangle(seq, price),
      cupHandle(seq, price),
    ].filter(Boolean);
    if (found.length) {
      found.sort((a, b) => b.quality - a.quality || b.recency - a.recency);
      return found[0];
    }
  }
  return flagPattern(candles, price) || { name: "none", bias: "neutral", quality: 0, recency: 0 };
}