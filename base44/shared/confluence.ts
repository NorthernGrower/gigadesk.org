// Structural confluence for the signal engine: Fibonacci retracements and
// extensions, a simplified probabilistic Elliott count, and support/resistance
// zones built from swing clusters. Every read is conservative — an ambiguous
// count or a thin leg returns "none"/null and contributes nothing to the score.

const pctMove = (from, to) => (from ? ((to - from) / from) * 100 : 0);

/**
 * The dominant completed impulse leg for one direction and where price sits
 * inside its retracement. For a long the leg runs from the last swing low to
 * the last swing high after it; mirrored for a short. Phase key:
 *   breakout  — price is at or beyond the impulse end
 *   chasing   — barely pulled back (< 0.236), no edge at this price
 *   shallow   — 0.236–0.382 pullback
 *   golden    — 0.382–0.618 pullback (the classic entry zone)
 *   deep      — 0.618–0.786 pullback (usable, no bonus)
 *   broken    — beyond the 0.786 level; the impulse leg is likely invalidated
 */
export function fibRead(pivotList, price, dir) {
  const empty = { phase: "none", retracement: null, targets: [], move_pct: 0 };
  const highs = pivotList.filter((p) => p.kind === "high");
  const lows = pivotList.filter((p) => p.kind === "low");
  if (!highs.length || !lows.length) return empty;

  let legEnd;
  let legStart;
  if (dir > 0) {
    legEnd = highs[highs.length - 1];
    legStart = [...lows].reverse().find((p) => p.i < legEnd.i);
  } else {
    legEnd = lows[lows.length - 1];
    legStart = [...highs].reverse().find((p) => p.i < legEnd.i);
  }
  if (!legStart) return empty;

  const start = legStart.price;
  const end = legEnd.price;
  const span = end - start;
  const movePct = Math.abs(pctMove(start, end));
  if (!(movePct >= 2)) return { ...empty, move_pct: movePct };

  // how far price has pulled back toward the leg origin, as a share of the leg
  const retracement = (end - price) / span;
  const targets = [start + span * 1.272, start + span * 1.618].filter((t) =>
    dir > 0 ? t > end : t < end,
  );

  let phase;
  if (retracement <= 0.05) phase = "breakout";
  else if (retracement > 1) phase = "broken";
  else if (retracement < 0.236) phase = "chasing";
  else if (retracement <= 0.382) phase = "shallow";
  else if (retracement <= 0.618) phase = "golden";
  else if (retracement <= 0.786) phase = "deep";
  else phase = "broken";

  return { phase, retracement, targets, move_pct: movePct };
}

/**
 * Simplified Elliott read from the alternating swing sequence: an aligned
 * series of two or three waves reads as an early/mid impulse, four or more as
 * a late-stage count (fresh entries chase the end of the move), a dominated
 * counter-swing series reads as corrective. Conflicting counts (highs rising
 * while lows fall, or the reverse) are ambiguous and return null.
 */
export function elliottRead(pivotList, dir) {
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
  const swings = seq.slice(-6);
  if (swings.length < 3) return { scenario: null, waves: 0 };

  const highs = swings.filter((p) => p.kind === "high");
  const lows = swings.filter((p) => p.kind === "low");
  const rising = (arr) => arr.slice(1).reduce((a, p, i) => a + (p.price > arr[i].price ? 1 : 0), 0);
  const up = dir > 0;
  const total = highs.length - 1 + (lows.length - 1);
  if (total < 2) return { scenario: null, waves: 0 };

  const highsAligned = up ? rising(highs) > highs.length - 1 - rising(highs) : rising(highs) < highs.length - 1 - rising(highs);
  const lowsAligned = up ? rising(lows) > lows.length - 1 - rising(lows) : rising(lows) < lows.length - 1 - rising(lows);
  const aligned = up
    ? rising(highs) + rising(lows)
    : highs.length - 1 - rising(highs) + (lows.length - 1 - rising(lows));
  if (highsAligned !== lowsAligned) return { scenario: null, waves: aligned };
  if (aligned >= 4) return { scenario: "impulse_late", waves: aligned };
  if (aligned >= 2) return { scenario: "impulse", waves: aligned };
  return { scenario: "corrective", waves: aligned };
}

/**
 * Support/resistance zones: swing highs and lows clustered within 0.6% of each
 * other. A zone with two or more touches is "strong"; price within 0.8% of a
 * strong zone counts as a retest.
 */
export function zoneRead(pivotList, price) {
  const cluster = (list) => {
    const sorted = list.map((p) => p.price).sort((a, b) => a - b);
    const out = [];
    for (const px of sorted) {
      const lastZone = out[out.length - 1];
      if (lastZone && Math.abs(px - lastZone.sum / lastZone.touches) <= price * 0.006) {
        lastZone.sum += px;
        lastZone.touches += 1;
      } else {
        out.push({ sum: px, touches: 1 });
      }
    }
    return out.map((z) => ({ price: z.sum / z.touches, touches: z.touches }));
  };
  const nearest = (zones) =>
    zones.length
      ? zones.reduce((a, b) => (Math.abs(b.price - price) < Math.abs(a.price - price) ? b : a))
      : null;
  const strong = (zones) => zones.filter((z) => z.touches >= 2);
  const near = (z) => (z ? Math.abs(z.price - price) / price <= 0.008 : false);

  const resistanceZones = strong(cluster(pivotList.filter((p) => p.kind === "high"))).filter(
    (z) => z.price > price * 1.002,
  );
  const supportZones = strong(cluster(pivotList.filter((p) => p.kind === "low"))).filter(
    (z) => z.price < price * 0.998,
  );
  const nearSupport = nearest(supportZones);
  const nearResistance = nearest(resistanceZones);
  return {
    strong_support: nearSupport ? nearSupport.price : null,
    strong_resistance: nearResistance ? nearResistance.price : null,
    at_support: near(nearSupport),
    at_resistance: near(nearResistance),
  };
}

/** How many consecutive recent bars closed beyond a level — the breakout age. */
export function breakoutAge(candles, level, dir) {
  let age = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const beyond = dir > 0 ? candles[i].c > level : candles[i].c < level;
    if (beyond) age += 1;
    else break;
  }
  return age;
}