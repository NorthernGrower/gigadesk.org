// Smart money: the top traders on Hyperliquid's public on-chain leaderboard,
// the live positions they hold, and the long/short bias those positions imply.
const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const INFO_URL = "https://api.hyperliquid.xyz/info";
export const SMART_WINDOWS = ["day", "week", "month", "allTime"];

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
};

export async function fetchLeaderboard() {
  const res = await fetch(LEADERBOARD_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Leaderboard request failed (${res.status})`);
  const data = await res.json();
  return data.leaderboardRows || [];
}

// Rank the board by PnL on the chosen window, among accounts large enough
// that their trades move markets and active enough that their results are
// real trades rather than transfer artifacts (the raw ROI field is noisy
// for accounts with zero traded volume).
export function rankTraders(
  rows,
  { window = "week", minAccountValue = 100000, minVolumeUsd = 1000000, count = 12 } = {},
) {
  const wi = Math.max(0, SMART_WINDOWS.indexOf(window));
  return rows
    .filter((r) => Number(r.accountValue) >= minAccountValue)
    .map((r) => {
      const perf = (r.windowPerformances || [])[wi]?.[1] || {};
      return {
        wallet: r.ethAddress,
        name: r.displayName || "",
        window,
        roi_pct: round(Number(perf.roi || 0) * 100),
        pnl_usd: round(Number(perf.pnl || 0)),
        volume_usd: round(Number(perf.vlm || 0)),
        account_value_usd: round(Number(r.accountValue || 0)),
      };
    })
    .filter((t) => t.volume_usd >= minVolumeUsd && t.pnl_usd > 0)
    .sort((a, b) => b.pnl_usd - a.pnl_usd)
    .slice(0, count)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

// The trader's current open positions, normalized.
export async function fetchTraderPositions(wallet) {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: wallet }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const state = await res.json();
  return (state.assetPositions || [])
    .map((a) => a.position)
    .filter(Boolean)
    .map((pos) => {
      const szi = Number(pos.szi) || 0;
      return {
        wallet,
        symbol: pos.coin,
        side: szi >= 0 ? "long" : "short",
        size_usd: round(Math.abs(Number(pos.positionValue) || 0)),
        entry_price: Number(pos.entryPx) || 0,
        leverage: Number(pos.leverage?.value) || 1,
        unrealized_pnl_usd: round(Number(pos.unrealizedPnl) || 0),
      };
    })
    .filter((p) => p.size_usd >= 1000);
}

// Per-symbol long/short totals across the tracked traders.
export function computeBias(positions) {
  const bySymbol = new Map();
  for (const p of positions) {
    const cur =
      bySymbol.get(p.symbol) ||
      { symbol: p.symbol, long_usd: 0, short_usd: 0, longs: 0, shorts: 0, traders: new Set() };
    if (p.side === "short") {
      cur.short_usd += p.size_usd;
      cur.shorts += 1;
    } else {
      cur.long_usd += p.size_usd;
      cur.longs += 1;
    }
    cur.traders.add(p.wallet);
    bySymbol.set(p.symbol, cur);
  }
  return [...bySymbol.values()]
    .map((b) => {
      const total = b.long_usd + b.short_usd;
      const longShare = total > 0 ? b.long_usd / total : 0.5;
      const dir = longShare >= 0.5 ? "long" : "short";
      return {
        symbol: b.symbol,
        long_usd: round(b.long_usd),
        short_usd: round(b.short_usd),
        longs: b.longs,
        shorts: b.shorts,
        traders: b.traders.size,
        dir,
        long_share_pct: round(longShare * 100, 0),
        total_usd: round(total),
      };
    })
    .sort((a, b) => b.total_usd - a.total_usd);
}

// What the bot's scoring reads: a map of symbol -> { long_usd, short_usd }
// from the stored snapshots, refreshed whenever getSmartMoney runs.
export async function loadSmartBias(base44) {
  const [longs, shorts] = await Promise.all([
    base44.entities.SmartPosition.aggregate({ query: { side: "long" }, groupBy: "symbol", sum: "size_usd" }),
    base44.entities.SmartPosition.aggregate({ query: { side: "short" }, groupBy: "symbol", sum: "size_usd" }),
  ]);
  const map = new Map();
  for (const r of longs?.rows || []) map.set(r.symbol, { long_usd: r.sum_size_usd || 0, short_usd: 0 });
  for (const r of shorts?.rows || []) {
    const cur = map.get(r.symbol) || { long_usd: 0, short_usd: 0 };
    cur.short_usd = r.sum_size_usd || 0;
    map.set(r.symbol, cur);
  }
  return map;
}