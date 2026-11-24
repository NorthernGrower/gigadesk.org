// The "always take the top picks" selection, as a pure function so it can be
// tested without a bot cycle. It decides *which* coins to buy; it never touches
// how they are managed — the caller keeps its own stop, target, trailing, sizing,
// cooldown, slot and risk rules.

export type TopPickOptions = {
  blocked: Set<string>;
  openSymbols: Set<string>;
  allowShorts?: boolean;
  count?: number;
  requireEntry?: boolean;
};

/**
 * Is this the moment to enter the pick, rather than chasing it?
 *
 * The scan gives us the coin's side and its indicators at the last close. A
 * good entry is near the mean, not extended from it: a long wants price within
 * 0.75 ATR of the 20 EMA, a short wants the mirror. An extreme RSI against the
 * side also means wait. Rows without indicator data are let through — missing
 * data must not silently disable the option.
 */
export function entryReady(row: any): boolean {
  if (!row) return false;
  const ind = row.indicators || {};
  const price = Number(row.price ?? row.entry);
  const ema20 = Number(ind.ema20);
  const atr = Number(ind.atr);
  const rsi = Number(ind.rsi);
  const long = row.side !== "short";
  if (!(price > 0)) return false;
  if (ema20 > 0 && atr > 0) {
    const stretch = long ? (price - ema20) / atr : (ema20 - price) / atr;
    if (stretch > 0.75) return false;
  }
  if (Number.isFinite(rsi)) {
    if (long && rsi >= 75) return false;
    if (!long && rsi <= 25) return false;
  }
  return true;
}

/**
 * The highest scoring rows that are safe to buy right now.
 *
 * A row is skipped when its symbol is blocked (cooldown, open position,
 * proposal), already held, missing a usable entry/stop pair, a short on a venue
 * that cannot short, or — when `requireEntry` is set — too extended from its
 * 20 EMA to be a good entry today. The result is deduplicated by symbol and
 * never longer than `count`.
 */
export function pickTopPicks(rows: any[], options: TopPickOptions): any[] {
  const blocked = options.blocked || new Set();
  const open = options.openSymbols || new Set();
  const allowShorts = options.allowShorts === true;
  const count = Math.max(0, Math.min(10, Number(options.count) || 0));
  if (!count) return [];

  const seen = new Set<string>();
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.symbol && !seen.has(row.symbol))
    .filter((row) => !blocked.has(row.symbol) && !open.has(row.symbol))
    .filter((row) => Number(row.entry) > 0 && Number(row.stop) > 0 && row.entry !== row.stop)
    .filter((row) => allowShorts || row.side !== "short")
    .filter((row) => options.requireEntry !== true || entryReady(row))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    .filter((row) => {
      // dedupe after the sort, so the first (highest scoring) wins
      if (seen.has(row.symbol)) return false;
      seen.add(row.symbol);
      return true;
    })
    .slice(0, count)
    .map((row) => ({ ...row, top_pick: true }));
}
