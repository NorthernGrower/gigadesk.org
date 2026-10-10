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

/** Symbol -> market cap map from CoinGecko's free markets feed (top 500, 15 min cache). */
async function loadCaps() {
  const cached = cacheGet("caps");
  if (cached) return cached;
  try {
    const pages = await Promise.all(
      [1, 2].map((p) =>
        fetchJson(
          `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}`,
          12000,
        ).catch((err) => {
          console.log(`caps page failed: ${err && err.message}`);
          return null;
        }),
      ),
    );
    const caps = new Map();
    for (const page of pages) {
      if (!Array.isArray(page)) continue;
      for (const c of page) {
        const sym = String(c.symbol || "").toUpperCase();
        if (sym && !caps.has(sym)) caps.set(sym, Number(c.market_cap) || 0);
      }
    }
    if (!caps.size) {
      console.log(`caps feed empty (pages: ${JSON.stringify(pages.map((p) => (Array.isArray(p) ? p.length : String(p))))})`);
      return null;
    }
    return cacheSet("caps", caps, 15 * 60 * 1000);
  } catch (err) {
    console.log(`caps fetch failed: ${err && err.message}`);
    return null;
  }
}

/** Whole-market snapshot: every tradable market on the exchange, ranked by traded volume. */
export async function fetchMarkets() {
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
  const caps = await loadCaps();
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

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}