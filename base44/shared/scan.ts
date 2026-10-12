import { fetchMarkets, fetchCandles, chunk, asArray, round } from "./market.ts";
import { analyzeCoin } from "./strategy.ts";

const SCOPES = new Set(["all", "large", "mid", "small"]);

const BARS_PER_DAY = { "15m": 96, "1h": 24, "4h": 6, "12h": 2, "1d": 1, "1w": 1 / 7, "1M": 1 / 30 };

function inScope(coin, scope) {
  if (!scope || scope === "all") return true;
  if (scope === "small") return coin.bucket === "small" || coin.bucket === "micro";
  return coin.bucket === scope;
}

/** Whole-market snapshot plus the market-wide median move used for relative strength. */
export async function loadUniverse() {
  const { coins, source } = await fetchMarkets();
  const moves = coins
    .map((c) => c.change24h)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const medianChange24h = moves.length ? moves[Math.floor(moves.length / 2)] : 0;
  return { coins, source, medianChange24h };
}

/** Picks which coins deserve candle analysis: the most liquid movers plus anything pinned. */
export function pickCandidates(coins, count, extraSymbols = []) {
  const ranked = [...coins].sort((a, b) => {
    const sa = a.volume24h * (1 + Math.min(Math.abs(a.change24h), 20) / 12);
    const sb = b.volume24h * (1 + Math.min(Math.abs(b.change24h), 20) / 12);
    return sb - sa;
  });
  const picked = new Map();
  ranked.slice(0, count).forEach((c) => picked.set(c.symbol, c));
  for (const sym of ["BTC", "ETH", ...extraSymbols]) {
    const found = coins.find((c) => c.symbol === String(sym || "").toUpperCase());
    if (found) picked.set(found.symbol, found);
  }
  return Array.from(picked.values());
}

function summarize(rows, coins) {
  const advancing = coins.filter((c) => c.change24h > 0).length;
  const avgScore = rows.length
    ? rows.reduce((a, r) => a + r.score, 0) / rows.length
    : 0;
  return {
    total: coins.length,
    advancing,
    declining: coins.length - advancing,
    breadth_pct: coins.length ? Math.round((advancing / coins.length) * 100) : 0,
    avg_score: Math.round(avgScore),
    strong_longs: rows.filter((r) => r.side === "long" && r.score >= 70).length,
    strong_shorts: rows.filter((r) => r.side === "short" && r.score >= 70).length,
    meeting_target: rows.filter((r) => r.meets_daily_target && r.score >= 62).length,
  };
}

/**
 * The ranked board: loads the whole market, analyses the strongest candidates and
 * returns them sorted by score with entry, target and stop attached.
 */
export async function scanBoard({
  timeframe = "1h",
  scope = "all",
  count = 60,
  dailyTargetPct = 2,
  extraSymbols = [],
  onlySymbols = null,
  confluenceV2 = true,
} = {}) {
  const safeScope = SCOPES.has(scope) ? scope : "all";
  const { coins, source, medianChange24h } = await loadUniverse();
  // coins with no market-cap data (0) are out of consideration whenever the
  // feed carries caps at all
  const hasCaps = coins.some((c) => (c.market_cap || 0) > 0);
  const scoped = coins.filter(
    (c) =>
      inScope(c, safeScope) &&
      (!hasCaps || (c.market_cap || 0) > 0) &&
      (!onlySymbols || onlySymbols.has(c.symbol)),
  );
  const candidates = pickCandidates(scoped, count, extraSymbols);

  const rows = [];
  for (const group of chunk(candidates, 6)) {
    const settled = await Promise.allSettled(
      group.map((c) => fetchCandles(c.symbol, timeframe, 300)),
    );
    settled.forEach((res, i) => {
      if (res.status !== "fulfilled" || !res.value || !res.value.length) return;
      const row = analyzeCoin(group[i], res.value, {
        medianChange24h,
        dailyTargetPct,
        barsPerDay: BARS_PER_DAY[timeframe] || 24,
        confluenceV2,
      });
      if (row) rows.push(row);
    });
  }
  rows.sort((a, b) => b.score - a.score);

  return {
    rows,
    universeCount: coins.length,
    scannedCount: rows.length,
    capsApplied: hasCaps,
    cappedCoins: coins.filter((c) => (c.market_cap || 0) > 0).length,
    capsDebug: source.capsDebug,
    medianChange24h: round(medianChange24h),
    source,
    updatedAt: new Date().toISOString(),
    summary: summarize(rows, coins),
  };
}

function signalRecord(row, timeframe) {
  return {
    symbol: row.symbol,
    name: row.name,
    coingecko_id: row.coingecko_id,
    image: row.image,
    side: row.side,
    timeframe,
    price: row.price,
    score: row.score,
    grade: row.grade,
    verdict: row.verdict,
    confidence: row.confidence,
    market_cap_bucket: row.market_cap_bucket,
    market_cap: row.market_cap,
    entry: row.entry,
    target: row.target,
    stop: row.stop,
    required_move_pct: row.required_move_pct,
    risk_reward: row.risk_reward,
    meets_daily_target: row.meets_daily_target,
    reasons: row.reasons,
    indicators: row.indicators,
    status: "new",
    detected_at: new Date().toISOString(),
  };
}

/** Stores the board as shared market-wide signals, updating today's instead of duplicating. */
export async function persistSignals(base44, rows, timeframe, limit = 12) {
  const top = rows.filter((r) => r.score >= 62).slice(0, limit);
  if (!top.length) return { created: 0, updated: 0 };

  const symbols = top.map((r) => r.symbol);
  const existing = asArray(
    await base44.asServiceRole.entities.Signal.filter(
      { symbol: { $in: symbols }, status: "new" },
      { limit: 200 },
    ),
  );
  const byKey = new Map(existing.map((s) => [`${s.symbol}|${s.side}`, s]));

  const creates = [];
  const updates = [];
  for (const row of top) {
    const record = signalRecord(row, timeframe);
    const found = byKey.get(`${row.symbol}|${row.side}`);
    if (found) updates.push({ id: found.id, ...record });
    else creates.push(record);
  }

  if (updates.length) {
    await base44.asServiceRole.entities.Signal.bulkUpdate(updates);
  }
  if (creates.length) {
    await base44.asServiceRole.entities.Signal.bulkCreate(creates);
  }
  return { created: creates.length, updated: updates.length };
}

/** One alert per fresh setup, throttled by symbol so the feed stays readable. */
export async function raiseSetupAlerts(base44, rows, limit = 3) {
  const picks = rows
    .filter((r) => r.score >= 68 && r.meets_daily_target)
    .slice(0, limit);
  if (!picks.length) return 0;

  const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const recent = asArray(
    await base44.entities.Alert.filter(
      { created_date: { $gte: since }, kind: "new_setup" },
      { limit: 100 },
    ),
  );
  const seen = new Set(recent.map((a) => a.symbol));
  const fresh = picks.filter((r) => !seen.has(r.symbol));
  if (!fresh.length) return 0;

  await base44.entities.Alert.bulkCreate(
    fresh.map((r) => ({
      symbol: r.symbol,
      title: `${r.symbol} ${r.side} setup — score ${r.score}`,
      message: `${String(r.verdict).replace("_", " ")} at ${r.entry}. Target ${r.target} (${r.required_move_pct}% move), stop ${r.stop}. ${r.reasons[0] || ""}`,
      mode: "paper",
      kind: "new_setup",
      severity: r.score >= 80 ? "success" : "info",
    })),
  );
  return fresh.length;
}