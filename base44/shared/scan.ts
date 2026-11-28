import { fetchMarkets, fetchBtcMarkets, fetchCandles, chunk, asArray, round, btcQuoteVenue } from "./market.ts";
import { fetchListedSymbols } from "./exchanges.ts";
import { analyzeCoin } from "./strategy.ts";

const SCOPES = new Set(["all", "large", "mid", "small"]);

const BARS_PER_DAY = { "15m": 96, "1h": 24, "4h": 6, "12h": 2, "1d": 1, "1w": 1 / 7, "1M": 1 / 30 };

function inScope(coin, scope) {
  if (!scope || scope === "all") return true;
  if (scope === "small") return coin.bucket === "small" || coin.bucket === "micro";
  return coin.bucket === scope;
}

/**
 * The venue a desk should scan and settle orders on: its chosen live
 * connection, else any connected trading-enabled account the user added.
 * `null` means the desk has no exchange attached and scans the shared feed.
 */
export async function resolveDeskVenue(base44, config) {
  try {
    const owner = (config && config.created_by_id) || "";
    const LR = (config && config.live_rules) || {};
    const id = LR.real_connection_id || (config && config.real_connection_id) || "";
    let conn = id
      ? await base44.asServiceRole.entities.ExchangeConnection.get(id).catch(() => null)
      : null;
    if (!conn || conn.status !== "connected" || conn.allow_trading !== true) {
      const rows = asArray(
        await base44.asServiceRole.entities.ExchangeConnection.filter(
          { created_by_id: owner, status: "connected", allow_trading: true },
          { sort: "-updated_date", limit: 1 },
        ),
      );
      conn = rows[0] || null;
    }
    if (!conn || conn.status !== "connected") return null;
    return {
      exchange: conn.exchange,
      testnet: Boolean(conn.testnet),
      label: conn.label || conn.exchange,
      balances: Array.isArray(conn.balances) ? conn.balances : [],
    };
  } catch (err) {
    console.log(`venue resolution failed: ${err && err.message}`);
    return null;
  }
}

/**
 * The connected exchange that can actually serve the Bitcoin book: a venue whose
 * own spot market lists pairs quoted in bitcoin, on an account this desk has
 * connected and not in backoff. The desk's chosen connection wins; another
 * connected venue that lists them stands in when the chosen one does not. A
 * view-only account still serves the scan, because the market read is public —
 * the live entry itself is what requires a trading-enabled connection.
 * `null` means no connected exchange can serve this book: its scan must then
 * read nothing, rather than a venue the desk has no account on.
 */
export async function resolveBtcVenue(base44, config, preferExchange = "") {
  try {
    const owner = (config && config.created_by_id) || "";
    const LR = (config && config.live_rules) || {};
    const id = LR.real_connection_id || (config && config.real_connection_id) || "";
    const rows = asArray(
      await base44.asServiceRole.entities.ExchangeConnection.filter(
        { created_by_id: owner, status: "connected" },
        { sort: "-updated_date", limit: 12 },
      ),
    ).filter(
      (c) => c && btcQuoteVenue(c.exchange) && !(c.backoff_until && Date.parse(c.backoff_until) > Date.now()),
    );
    if (!rows.length) return null;
    // prefer a venue whose BTC listing actually answers: a connected account on
    // a venue with no BTC pairs must not become the feed while another
    // connected venue can serve the book
    const withPairs = [];
    for (const c of rows) {
      const listed = await fetchListedSymbols(
        { exchange: c.exchange, testnet: Boolean(c.testnet) },
        ["BTC"],
      );
      if (listed && listed.size) withPairs.push(c);
    }
    const pool = withPairs.length ? withPairs : rows;
    // a listed pair is not a working ticker: one connected venue can answer its
    // pair list and still return no BTC market (a blocked public endpoint, a
    // region restriction). Probe each candidate and keep the ones that actually
    // answer rows, so the desk never reads an empty board from a dead venue
    // while another connected venue lists pairs fine.
    const withRows = [];
    for (const c of pool) {
      const probe = await fetchBtcMarkets(
        null,
        { exchange: c.exchange, testnet: Boolean(c.testnet) },
        1,
      ).catch(() => []);
      if (probe && probe.length) withRows.push(c);
    }
    const live = withRows.length ? withRows : pool;
    // the live connection must be the venue the book trades on, or a live BTC
    // order would have no market to fill on: its exchange wins whenever it
    // lists BTC pairs, and any connected venue stands in for the paper book
    const preferred = preferExchange
      ? live.filter((c) => String(c.exchange || "") === String(preferExchange))
      : [];
    const chosen = preferred.find((c) => c.id === id) || preferred[0] || live.find((c) => c.id === id) || live[0];
    return {
      id: chosen.id,
      exchange: chosen.exchange,
      testnet: Boolean(chosen.testnet),
      label: chosen.label || chosen.exchange,
      balances: Array.isArray(chosen.balances) ? chosen.balances : [],
    };
  } catch (err) {
    console.log(`BTC venue resolution failed: ${err && err.message}`);
    return null;
  }
}

/**
 * Every BTC-paired symbol the user's connected exchanges actually list. All
 * connected venues count, not just the one chosen for orders: a paper BTC desk
 * has nothing to settle, so a view-only Kraken account is just as good a source
 * of the pair list as a trading-enabled one. Null means no connected venue can
 * serve BTC pairs, which is different from an empty list and must never be
 * passed to a scanner as "nothing is listed".
 */
export async function resolveBtcSymbols(base44, config) {
  const owner = (config && config.created_by_id) || "";
  const rows = asArray(
    await base44.asServiceRole.entities.ExchangeConnection.filter(
      { created_by_id: owner, status: "connected" },
      { sort: "-updated_date", limit: 12 },
    ).catch(() => []),
  ).filter(
    (c) => c && btcQuoteVenue(c.exchange) && !(c.backoff_until && Date.parse(c.backoff_until) > Date.now()),
  );
  if (!rows.length) return null;
  const listed = new Set();
  for (const conn of rows) {
    const symbols = await fetchListedSymbols(
      {
        exchange: conn.exchange,
        testnet: Boolean(conn.testnet),
        api_key: "",
        api_secret: "",
        passphrase: "",
      },
      ["BTC"],
    );
    if (symbols) for (const s of symbols) listed.add(String(s).toUpperCase());
  }
  return listed.size ? listed : null;
}

/** Whole-market snapshot plus the market-wide median move used for relative strength. */
export async function loadUniverse(db = null, feed = null, quote = "USD", btcUsd = 0) {
  // a Bitcoin market is its own universe: Kraken's XBT pairs, priced in BTC.
  // Its turnover is put in dollars at the rate, so liquidity keeps the same
  // meaning on both books and the two never share a row.
  if (String(quote || "USD").toUpperCase() === "BTC") {
    const btcCoins = await fetchBtcMarkets(db, feed, btcUsd);
    const btcMoves = btcCoins.map((c) => c.change24h).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return {
      coins: btcCoins,
      source: { exchange: (feed && feed.exchange) || "kraken", quote: "BTC" },
      medianChange24h: btcMoves.length ? btcMoves[Math.floor(btcMoves.length / 2)] : 0,
    };
  }
  const { coins, source } = await fetchMarkets(db, feed);
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
  feed = null,
  db = null,
  quote = "USD",
  btcUsd = 0,
} = {}) {
  const safeScope = SCOPES.has(scope) ? scope : "all";
  const { coins, source, medianChange24h } = await loadUniverse(db, feed, quote, btcUsd);
  // coins with no market-cap data (0) are out of consideration whenever the
  // feed carries caps at all. The BTC book is ranked by turnover, not by a
  // market cap: dropping its pairs for a missing cap would blank the book.
  const hasCaps = String(quote || "USD").toUpperCase() !== "BTC" && coins.some((c) => (c.market_cap || 0) > 0);
  const scoped = coins.filter(
    (c) =>
      inScope(c, safeScope) &&
      (!hasCaps || (c.market_cap || 0) > 0) &&
      (!onlySymbols || onlySymbols.has(c.symbol)),
  );
  const candidates = pickCandidates(scoped, count, extraSymbols);

  const rows = [];
  // kline requests are cheap (weight 2 each, far under the limit), so a
  // wider batch shortens the scan's serial rounds from ~10 to ~6
  for (const group of chunk(candidates, 10)) {
    const settled = await Promise.allSettled(
      group.map((c) => fetchCandles(c.symbol, timeframe, 300, feed, quote)),
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
    quality: row.quality,
    confluence: row.confluence,
    categories: row.categories,
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