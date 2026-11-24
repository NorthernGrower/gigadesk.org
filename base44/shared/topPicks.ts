// The "always take the top picks" selection, as a pure function so it can be
// tested without a bot cycle. It decides *which* coins to buy; it never touches
// how they are managed — the caller keeps its own stop, target, trailing, sizing,
// cooldown, slot and risk rules.

export type TopPickOptions = {
  blocked: Set<string>;
  openSymbols: Set<string>;
  allowShorts?: boolean;
  count?: number;
};

/**
 * The highest scoring rows that are safe to buy right now.
 *
 * A row is skipped when its symbol is blocked (cooldown, open position,
 * proposal), already held, missing a usable entry/stop pair, or a short on a
 * venue that cannot short. The result is deduplicated by symbol and never
 * longer than `count`.
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
