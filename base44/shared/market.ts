const BASE = "https://api.binance.us/api/v3";

const STABLES = new Set([
  "USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "USDS", "PYUSD", "BUSD",
  "USDD", "GUSD", "FRAX", "USD1", "EURC", "EURT", "USTC", "USDP", "USDF",
]);

const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

const store = new Map();

/** Record results may arrive as a plain array or as a page object. */
export function asArray(res) {
  if (Array.isArray(res)) return res;
  return (res && res.items) || [];
}

export function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
}

export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

export function cacheSet(key, value, ttl) {
  store.set(key, { value, at: Date.now(), ttl });
  return value;
}

export async function fetchJson(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

export function isStable(symbol) {
  return STABLES.has(String(symbol || "").toUpperCase());
}

export function pairFor(symbol) {
  return `${String(symbol || "").toUpperCase()}USDT`;
}

/** Liquidity tier by rank, so large caps and micro caps can be scanned separately. */
function tierFor(index) {
  if (index < 20) return "large";
  if (index < 80) return "mid";
  if (index < 160) return "small";
  return "micro";
}

/**
 * Symbol -> market cap map from free feeds (15 min cache). The scan runtime is
 * blocked by some providers, so sources are tried in order until one answers.
 * Whichever source answered last is tried first next time: coingecko and
 * coincap sit down for days (429s, 530s), and re-probing them before a working
 * source burns tens of seconds of every caps refresh.
 */
let lastGoodCapSource = null;

/** A function instance is short-lived: without a durable copy, every cycle
 * re-probed the cap feeds, and the dead providers (429s, 530s) cost tens of
 * seconds of every cycle. When a db client is passed, the last good caps
 * snapshot is stored on the desk and read back here. */
async function readCapsFromDb(db) {
  if (!db) return null;
  try {
    const rows = asArray(
      await db.entities.MarketCache.filter({ key: "caps" }, { limit: 1 }),
    );
    const value = rows[0] && rows[0].value;
    if (!value) return null;
    if (value.failed_at) return { failedAt: Date.parse(value.failed_at) || 0 };
    if (!Array.isArray(value.caps) || !value.caps.length) return null;
    const savedAt = Date.parse(value.saved_at || "");
    if (Number.isFinite(savedAt) && Date.now() - savedAt > 7 * 24 * 3600 * 1000) return null;
    return new Map(value.caps);
  } catch {
    // the desk cache is an optimisation, never a hard dependency
    return null;
  }
}

let lastGoodCaps = null;

/** Persists a good caps snapshot, or — with null — a "sources are down" marker
 * so the next cycles skip the dead providers' timeouts instead of paying them
 * again and again. */
async function saveCapsToDb(db, caps) {
  if (caps) lastGoodCaps = caps;
  if (!db) return;
  try {
    await db.entities.MarketCache.upsert(
      [
        caps
          ? { key: "caps", value: { caps: Array.from(caps.entries()), saved_at: new Date().toISOString() } }
          : { key: "caps", value: { failed_at: new Date().toISOString() } },
      ],
      { key: "key" },
    );
  } catch (err) {
    console.log(`caps desk-cache save failed: ${err && err.message}`);
  }
}

async function loadCaps(db = null) {
  const cached = cacheGet("caps");
  if (cached) return cached;
  const stored = await readCapsFromDb(db);
  if (stored instanceof Map && stored.size) {
    console.log(`caps loaded from desk cache: ${stored.size} symbols`);
    return cacheSet("caps", stored, 15 * 60 * 1000);
  }
  if (stored && stored.failedAt && Date.now() - stored.failedAt < 5 * 60 * 1000) {
    // the sources failed moments ago — skip their timeouts this cycle
    console.log("caps sources failed recently - skipping the probe");
    return lastGoodCaps;
  }

  const sources = [
    {
      name: "coinpaprika",
      pages: ["https://api.coinpaprika.com/v1/tickers"],
      headers: { accept: "application/json" },
      list: (res) => (Array.isArray(res) ? res : []),
      capOf: (c) => Number((((c || {}).quotes || {}).USD || {}).market_cap) || 0,
    },
    {
      name: "coingecko",
      pages: [
        "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1",
        "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2",
      ],
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
      list: (res) => (Array.isArray(res) ? res : []),
      capOf: (c) => Number(c.market_cap) || 0,
    },
    {
      name: "coincap",
      pages: ["https://api.coincap.io/v2/assets?limit=2000"],
      headers: { accept: "application/json" },
      list: (res) => (Array.isArray(res && res.data) ? res.data : []),
      capOf: (c) => Number(c.marketCapUsd) || 0,
    },
  ];

  if (lastGoodCapSource) {
    const idx = sources.findIndex((s) => s.name === lastGoodCapSource);
    if (idx > 0) sources.unshift(...sources.splice(idx, 1));
  }

  for (const src of sources) {
    try {
      const lists = await Promise.all(
        src.pages.map((url) =>
          fetch(url, { headers: src.headers, signal: AbortSignal.timeout(12000) })
            .then((res) => {
              if (!res.ok) throw new Error(`responded ${res.status}`);
              return res.json();
            })
            .catch((err) => {
              console.log(`caps ${src.name} page failed: ${err && err.message}`);
              return null;
            }),
        ),
      );
      const caps = new Map();
      for (const res of lists) {
        for (const c of src.list(res)) {
          const sym = String((c || {}).symbol || "").toUpperCase();
          if (sym && !caps.has(sym)) caps.set(sym, src.capOf(c));
        }
      }
      if (caps.size) {
        console.log(`caps loaded from ${src.name}: ${caps.size} symbols`);
        lastGoodCapSource = src.name;
        await saveCapsToDb(db, caps);
        return cacheSet("caps", caps, 15 * 60 * 1000);
      }
    } catch (err) {
      console.log(`caps ${src.name} failed: ${err && err.message}`);
    }
  }
  // every live source is down: mark the failure (so the next cycles skip the
  // dead providers' timeouts) and serve the last snapshot this instance saw
  await saveCapsToDb(db, null);
  return lastGoodCaps;
}

/** Whole-market snapshot: every tradable market on the exchange, ranked by traded volume. */
export async function fetchMarkets(db = null) {
  const cached = cacheGet("markets");
  if (cached) return { ...cached, capsDebug: -2 };

  const rows = await fetchJson(`${BASE}/ticker/24hr`, 20000);
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("The market feed is unavailable right now - try again shortly.");
  }

  const coins = rows
    .filter(
      (r) =>
        typeof r.symbol === "string" &&
        r.symbol.endsWith("USDT") &&
        !LEVERAGED.test(r.symbol),
    )
    .map((r) => {
      const symbol = r.symbol.slice(0, -4);
      return {
        symbol,
        name: symbol,
        coingecko_id: "",
        image: "",
        price: Number(r.lastPrice) || 0,
        market_cap: 0,
        volume24h: Number(r.quoteVolume) || 0,
        change24h: Number(r.priceChangePercent) || 0,
        change7d: 0,
        rank: 0,
      };
    })
    .filter((c) => c.price > 0 && !isStable(c.symbol))
    .sort((a, b) => b.volume24h - a.volume24h);

  // Real market caps (best effort): coins the cap feed has no data for stay at
  // 0 and are skipped when the bot picks candidates.
  const caps = await loadCaps(db);
  console.log(`caps loaded: ${caps ? caps.size : "none"}`);
  if (caps && caps.size) {
    for (const c of coins) c.market_cap = caps.get(c.symbol) || 0;
  }

  coins.forEach((c, i) => {
    c.bucket = tierFor(i);
    c.rank = i + 1;
  });

  if (!coins.length) {
    throw new Error("The market feed is unavailable right now - try again shortly.");
  }
  return cacheSet(
    "markets",
    { coins, source: "binance_us", capsDebug: caps && caps.size ? caps.size : -1 },
    60000,
  );
}

/** OHLCV candles. Returns null when a coin has no tradable pair. */
export async function fetchCandles(symbol, interval = "1h", limit = 300) {
  const key = `k:${symbol}:${interval}:${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let rows = null;
  try {
    rows = await fetchJson(
      `${BASE}/klines?symbol=${pairFor(symbol)}&interval=${interval}&limit=${limit}`,
      12000,
    );
  } catch (err) {
    rows = null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;

  const candles = rows.map((r) => ({
    t: r[0],
    o: +r[1],
    h: +r[2],
    l: +r[3],
    c: +r[4],
    v: +r[5],
  }));
  return cacheSet(key, candles, 45000);
}

/**
 * Deep candle history for backtests: pages Binance US klines backwards from
 * now, ~1000 bars per call, until the window covers the wanted months (the
 * public kline endpoint allows this freely). Historical bars never change
 * once closed, so the assembled series is cached for ten minutes.
 */
export async function fetchCandlesHistory(symbol, interval = "1h", months = 6) {
  const key = `hist:${symbol}:${interval}:${months}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const startMs = Date.now() - months * 30 * 24 * 3600 * 1000;
  const pages = [];
  let endMs = Date.now();
  for (let page = 0; page < 12; page++) {
    let rows = null;
    try {
      rows = await fetchJson(
        `${BASE}/klines?symbol=${pairFor(symbol)}&interval=${interval}&limit=1000&endTime=${endMs}`,
        12000,
      );
    } catch (err) {
      break;
    }
    if (!Array.isArray(rows) || !rows.length) break;
    pages.push(rows);
    const oldest = Number(rows[0][0]);
    if (oldest <= startMs) break;
    endMs = oldest - 1;
  }
  const candles = [];
  const seen = new Set();
  for (const rows of pages.reverse()) {
    for (const r of rows) {
      const c = { t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] };
      if (c.t < startMs || !(c.c > 0) || seen.has(c.t)) continue;
      seen.add(c.t);
      candles.push(c);
    }
  }
  return cacheSet(key, candles, 10 * 60000);
}

const KRAKEN_PUBLIC = "https://api.kraken.com/0/public";

/**
 * Live last prices for the handful of symbols the bot is acting on. One
 * batched public call covers up to 100 symbols (weight 2), a single Kraken
 * call covers pairs the US feed does not list, and a 30-second cache keeps
 * overlapping cycles from repeating the calls — so tracking stays live
 * without denting either exchange's rate limits.
 */
export async function fetchLivePrices(symbols, quoteAsset = "USDT") {
  const wanted = [...new Set((symbols || []).filter(Boolean).map((s) => String(s).toUpperCase()))];
  const map = new Map();
  if (!wanted.length) return map;
  const key = `live:${quoteAsset}:${wanted.slice().sort().join(",")}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    for (const group of chunk(wanted, 100)) {
      const qs = encodeURIComponent(JSON.stringify(group.map((s) => `${s}${quoteAsset}`)));
      const rows = await fetchJson(`${BASE}/ticker/price?symbols=${qs}`, 8000);
      for (const r of Array.isArray(rows) ? rows : []) {
        const px = Number(r.price) || 0;
        if (px > 0) map.set(String(r.symbol).slice(0, -quoteAsset.length), px);
      }
    }
  } catch (err) {
    console.log(`live prices failed: ${err && err.message}`);
  }

  // pairs the US feed does not list (real positions can sit on other
  // exchanges): one best-effort Kraken public call, no keys involved
  const missing = wanted.filter((s) => !map.has(s));
  if (missing.length) {
    try {
      const res = await fetchJson(
        `${KRAKEN_PUBLIC}/Ticker?pair=${missing.map((s) => `${s}USD`).join(",")}`,
        8000,
      );
      const rows = (res && res.result) || {};
      for (const sym of missing) {
        const pairKey = rows[`${sym}USD`]
          ? `${sym}USD`
          : Object.keys(rows).find((k) => k.toUpperCase().startsWith(sym));
        const px = pairKey ? Number(rows[pairKey].c && rows[pairKey].c[0]) || 0 : 0;
        if (px > 0) map.set(sym, px);
      }
    } catch (err) {
      console.log(`kraken live prices failed: ${err && err.message}`);
    }
  }
  return cacheSet(key, map, 30000);
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}