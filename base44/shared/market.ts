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

/** A function instance is short-lived: when the live feed 429s or times out,
 * the only durable copy of the markets snapshot is this desk-cache row —
 * without it, every cycle inside the outage window fails the bot page. */
async function readMarketsFromDb(db) {
  if (!db) return null;
  try {
    const rows = asArray(
      await db.entities.MarketCache.filter({ key: "markets" }, { limit: 1 }),
    );
    const value = rows[0] && rows[0].value;
    if (!value || !Array.isArray(value.slim) || !value.slim.length) return null;
    const savedAt = Date.parse(value.saved_at || "");
    // prices age: beyond an hour a snapshot is too stale to size trades on
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > 60 * 60 * 1000) return null;
    return value.slim;
  } catch {
    // the desk cache is an optimisation, never a hard dependency
    return null;
  }
}

/** Persists the last good markets snapshot as slim tuples: symbol, price, volume, 24h change. */
async function saveMarketsToDb(db, coins) {
  if (!db) return;
  try {
    await db.entities.MarketCache.upsert(
      [
        {
          key: "markets",
          value: {
            slim: coins.map((c) => [
              c.symbol,
              round(c.price, 8),
              round(c.volume24h),
              round(c.change24h, 2),
            ]),
            saved_at: new Date().toISOString(),
          },
        },
      ],
      { key: "key" },
    );
  } catch (err) {
    console.log(`markets desk-cache save failed: ${err && err.message}`);
  }
}

// ---- Venue-native market data -------------------------------------------
// A desk that trades on Kraken, Bybit or KuCoin must scan that venue's own
// market: coins listed only there would never appear in the US feed. These
// public endpoints need no keys, so the scan works for any connected exchange.
const VENUE_BASE = {
  kucoin: "https://api.kucoin.com",
  bybit: "https://api.bybit.com",
  kraken: "https://api.kraken.com",
};

const VENUE_INTERVAL = {
  kucoin: { "15m": "15min", "1h": "1hour", "4h": "4hour", "12h": "12hour", "1d": "1day", "1w": "1week", "1M": "1week" },
  bybit: { "15m": "15", "1h": "60", "4h": "240", "12h": "720", "1d": "D", "1w": "W", "1M": "M" },
  kraken: { "15m": 15, "1h": 60, "4h": 240, "12h": 720, "1d": 1440, "1w": 10080, "1M": 21600 },
};

const VENUE_QUOTES = ["USDT", "USD", "USDC"];

const KUCOIN_BAR_MS = {
  "15min": 900000,
  "1hour": 3600000,
  "4hour": 14400000,
  "12hour": 43200000,
  "1day": 86400000,
  "1week": 604800000,
};

// Kraken names assets its own way (XBT for BTC, Z-prefixed fiat)
const KRAKEN_ALIAS = {
  XXBT: "BTC", XBT: "BTC", XETH: "ETH", XXDG: "DOGE", XDG: "DOGE", XXRP: "XRP",
  XLTC: "LTC", XXLM: "XLM", XZEC: "ZEC", XMLN: "MLN", XREP: "REP", XETC: "ETC",
  ZUSD: "USD", ZEUR: "EUR", ZGBP: "GBP", ZCAD: "CAD", ZAUD: "AUD", ZJPY: "JPY",
  ZCHF: "CHF",
};
const krakenBase = (a) => KRAKEN_ALIAS[String(a || "").toUpperCase()] || String(a || "").toUpperCase();

/** Kraken pair names as the desk reads them: canonical key and altname both. */
async function krakenPairIndex() {
  const cached = cacheGet("kraken:pairs");
  if (cached) return cached;
  const res = await fetchJson(`${VENUE_BASE.kraken}/0/public/AssetPairs`, 12000);
  const byCanonical = new Map();
  const byAlt = new Map();
  for (const p of Object.values((res && res.result) || {})) {
    if (!p || (p.status && p.status !== "online")) continue;
    const entry = {
      base: krakenBase(p.base),
      quote: krakenBase(p.quote),
      altname: String(p.altname || "").toUpperCase(),
    };
    byCanonical.set(`${String(p.base || "").toUpperCase()}${String(p.quote || "").toUpperCase()}`, entry);
    if (entry.altname) byAlt.set(entry.altname, entry);
  }
  return cacheSet("kraken:pairs", { byCanonical, byAlt }, 30 * 60000);
}

/** The venue's own 24h ticker as the desk's coin rows (no market caps here). */
export async function fetchVenueMarkets(feed) {
  const ex = String((feed && feed.exchange) || "");
  const base = VENUE_BASE[ex];
  if (!base || ex === "binance" || ex === "binance_us") return [];
  const out = [];
  if (ex === "kucoin") {
    const res = await fetchJson(`${base}/api/v1/market/allTickers`, 15000);
    for (const t of ((res && res.data) || {}).ticker || []) {
      const [sym, quote] = String(t.symbol || "").split("-");
      const price = Number(t.last) || 0;
      if (!sym || !VENUE_QUOTES.includes(quote) || !(price > 0)) continue;
      out.push({
        symbol: sym.toUpperCase(),
        price,
        volume24h: Number(t.volValue) || 0,
        change24h: (Number(t.changeRate) || 0) * 100,
      });
    }
  } else if (ex === "bybit") {
    const res = await fetchJson(`${base}/v5/market/tickers?category=spot`, 15000);
    for (const t of ((res && res.data) || {}).result?.list || []) {
      const sym = String(t.symbol || "").toUpperCase();
      const quote = VENUE_QUOTES.find((q) => sym.endsWith(q));
      const price = Number(t.lastPrice) || 0;
      if (!quote || !(price > 0)) continue;
      out.push({
        symbol: sym.slice(0, -quote.length),
        price,
        volume24h: Number(t.turnover24h) || 0,
        change24h: (Number(t.price24hPcnt) || 0) * 100,
      });
    }
  } else if (ex === "kraken") {
    // Kraken has no bulk ticker: the pairs are read in groups, then each
    // result's pair name is mapped back to its base asset
    const idx = await krakenPairIndex();
    // the desk's Kraken orders settle in USD, so only USD/USDT markets matter
    const pairs = [...idx.byCanonical.values()].filter((p) => p.quote === "USD" || p.quote === "USDT");
    for (const group of chunk(pairs, 80)) {
      try {
        const res = await fetchJson(
          `${base}/0/public/Ticker?pair=${group.map((p) => p.altname).join(",")}`,
          12000,
        );
        for (const [key, t] of Object.entries((res && res.result) || {})) {
          const p = idx.byCanonical.get(String(key).toUpperCase()) || idx.byAlt.get(String(key).toUpperCase());
          if (!p || !t) continue;
          const last = Number(t.c && t.c[0]) || 0;
          const open = Number(t.o && t.o[1]) || 0;
          const vwap = Number(t.p && t.p[1]) || last;
          if (!(last > 0)) continue;
          out.push({
            symbol: p.base,
            price: last,
            volume24h: (Number(t.v && t.v[1]) || 0) * vwap,
            change24h: open > 0 ? (last / open - 1) * 100 : 0,
          });
        }
      } catch (err) {
        console.log(`kraken ticker batch failed: ${err && err.message}`);
      }
    }
  }
  return out;
}

// The venues whose spot market lists pairs quoted in bitcoin. The Bitcoin book
// prices, charts, sizes and settles in BTC, so only a venue that lists those
// pairs can serve it: a connected exchange without them can never trade this
// book, whatever its account holds.
export const BTC_QUOTE_VENUES = new Set(["kraken"]);

export const btcQuoteVenue = (exchange) =>
  BTC_QUOTE_VENUES.has(String(exchange || "").trim().toLowerCase());

/**
 * Kraken's Bitcoin-quoted markets as the desk's own coin rows, priced in BTC.
 *
 * This is a market in its own right, not a view of the dollar one: a SOL/XBT
 * chart moves differently from SOL/USD, and the desk trades it, sizes it and
 * exits it in bitcoin. `btcUsd` turns each pair's turnover into dollars, so the
 * liquidity floor and the volume ranking keep meaning what they mean on the
 * dollar book. Without a rate the volume stays 0, which excludes the row
 * instead of flattering it.
 */
export async function fetchBtcMarkets(db = null, feed = null, btcUsd = 0) {
  const ex = String((feed && feed.exchange) || "");
  const base = VENUE_BASE[ex];
  const fx = Number(btcUsd) || 0;
  // only a venue that lists pairs quoted in bitcoin can serve this book: its
  // pair names and its ticker are the ones the order path uses, and a market
  // the desk cannot trade is noise
  if (!btcQuoteVenue(ex) || !base || !(fx > 0)) return [];
  const key = `btcmarkets:${ex}:${Math.round(fx / 100)}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const idx = await krakenPairIndex();
  const pairs = [...idx.byCanonical.values()].filter(
    (p) => p.quote === "BTC" && p.base !== "BTC" && !isStable(p.base),
  );
  if (!pairs.length) return [];

  const out = [];
  for (const group of chunk(pairs, 80)) {
    try {
      const res = await fetchJson(
        `${base}/0/public/Ticker?pair=${group.map((p) => p.altname).join(",")}`,
        12000,
      );
      for (const [tickKey, t] of Object.entries((res && res.result) || {})) {
        const p =
          idx.byCanonical.get(String(tickKey).toUpperCase()) ||
          idx.byAlt.get(String(tickKey).toUpperCase());
        if (!p || p.quote !== "BTC" || !t) continue;
        const last = Number(t.c && t.c[0]) || 0;
        const open = Number(t.o && t.o[1]) || 0;
        const vwap = Number(t.p && t.p[1]) || last;
        if (!(last > 0)) continue;
        out.push({
          symbol: p.base,
          price: last,
          volume24h: (Number(t.v && t.v[1]) || 0) * vwap * fx,
          change24h: open > 0 ? (last / open - 1) * 100 : 0,
        });
      }
    } catch (err) {
      console.log(`kraken BTC ticker batch failed: ${err && err.message}`);
    }
  }
  const coins = await finalizeCoins(db, out);
  return cacheSet(key, coins, 60000);
}

/** The venue's OHLCV for one coin, oldest bar first. Null when it has no pair.
 *  `quote` asks for a specific market: a BTC-quoted read must never be answered
 *  with a USD chart, so it returns null rather than falling back across quotes. */
export async function fetchVenueCandles(feed, symbol, interval = "1h", limit = 300, quote = "USD") {
  const ex = String((feed && feed.exchange) || "");
  const base = VENUE_BASE[ex];
  const iv = VENUE_INTERVAL[ex] && VENUE_INTERVAL[ex][interval];
  const sym = String(symbol || "").toUpperCase();
  const wantBtc = String(quote || "USD").toUpperCase() === "BTC";
  if (!base || !iv || !sym) return null;
  // a BTC-quoted read must never be answered with a dollar chart: only a venue
  // that lists those pairs can answer it, and anything else returns null
  if (wantBtc && !btcQuoteVenue(ex)) return null;
  try {
    if (ex === "kucoin") {
      // KuCoin's candle endpoint answers with the last 100 bars unless the
      // window is asked for: the analyser needs a full series (EMA200, RSI,
      // Bollinger), so the range is set from the bar count wanted
      const spanMs = limit * (KUCOIN_BAR_MS[iv] || 3600000);
      const now = Math.floor(Date.now() / 1000);
      const startAt = Math.floor((Date.now() - spanMs) / 1000);
      const res = await fetchJson(
        `${base}/api/v1/market/candles?type=${iv}&symbol=${sym}-USDT&startAt=${startAt}&endAt=${now}`,
        12000,
      );
      // KuCoin rows are [time, open, close, high, low, volume, turnover],
      // newest first
      const rows = Array.isArray(res && res.data) ? res.data : [];
      return rows
        .map((r) => ({ t: Number(r[0]) * 1000, o: +r[1], h: +r[3], l: +r[4], c: +r[2], v: +r[5] }))
        .sort((a, b) => a.t - b.t)
        .slice(-limit);
    }
    if (ex === "bybit") {
      const res = await fetchJson(
        `${base}/v5/market/kline?category=spot&symbol=${sym}USDT&interval=${iv}&limit=${limit}`,
        12000,
      );
      const rows = ((res && res.data) || {}).result?.list || [];
      return rows
        .map((r) => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
        .sort((a, b) => a.t - b.t);
    }
    if (ex === "kraken") {
      const idx = await krakenPairIndex();
      const pair = wantBtc
        ? [...idx.byCanonical.values()].find((p) => p.base === sym && p.quote === "BTC")
        : [...idx.byCanonical.values()].find((p) => p.base === sym && p.quote === "USD") ||
          [...idx.byCanonical.values()].find((p) => p.base === sym && VENUE_QUOTES.includes(p.quote));
      if (!pair) return null;
      const res = await fetchJson(
        `${base}/0/public/OHLC?pair=${pair.altname}&interval=${iv}`,
        12000,
      );
      const result = (res && res.result) || {};
      const rows = result[pair.altname] || Object.entries(result).find(([k]) => k !== "last")?.[1] || [];
      // [time(sec), open, high, low, close, vwap, volume, count]
      return (Array.isArray(rows) ? rows : [])
        .map((r) => ({ t: Number(r[0]) * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] }))
        .sort((a, b) => a.t - b.t)
        .slice(-limit);
    }
  } catch (err) {
    console.log(`${ex} candles for ${sym} failed: ${err && err.message}`);
  }
  return null;
}

/** Last prices for coins neither the US feed nor Kraken lists (wallet holdings
 * on another venue still get valued instead of showing as zero). */
async function venuePriceFallback(symbols) {
  const out = new Map();
  const missing = symbols.filter((s) => s);
  if (!missing.length) return out;
  const take = (sym, px) => {
    if (px > 0 && missing.includes(sym) && !out.has(sym)) out.set(sym, px);
  };
  try {
    const res = await fetchJson(`${VENUE_BASE.kucoin}/api/v1/market/allTickers`, 10000);
    for (const t of ((res && res.data) || {}).ticker || []) {
      const [sym, quote] = String(t.symbol || "").split("-");
      if (quote !== "USDT") continue;
      take(String(sym || "").toUpperCase(), Number(t.last) || 0);
    }
  } catch (err) {
    // a venue outage never blocks a valuation
  }
  if (out.size < missing.length) {
    try {
      const res = await fetchJson(`${VENUE_BASE.bybit}/v5/market/tickers?category=spot`, 10000);
      for (const t of ((res && res.data) || {}).result?.list || []) {
        const sym = String(t.symbol || "").toUpperCase();
        if (!sym.endsWith("USDT")) continue;
        take(sym.slice(0, -4), Number(t.lastPrice) || 0);
      }
    } catch (err) {
      // same
    }
  }
  return out;
}

/** Caps, liquidity tiers and rank applied to a venue's raw ticker rows. */
async function finalizeCoins(db, list) {
  const coins = (list || [])
    .filter((c) => c && c.price > 0 && !isStable(c.symbol))
    .sort((a, b) => b.volume24h - a.volume24h);
  if (!coins.length) return [];
  const caps = await loadCaps(db);
  console.log(`caps loaded: ${caps ? caps.size : "none"}`);
  if (caps && caps.size) {
    for (const c of coins) c.market_cap = caps.get(c.symbol) || 0;
  }
  // one row per coin: a venue quoting the same base in USD and USDT lists it twice
  const seen = new Set();
  const unique = [];
  for (const c of coins) {
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    unique.push(c);
  }
  unique.forEach((c, i) => {
    c.name = c.symbol;
    c.coingecko_id = c.coingecko_id || "";
    c.image = c.image || "";
    c.market_cap = c.market_cap || 0;
    c.change7d = c.change7d || 0;
    c.bucket = tierFor(i);
    c.rank = i + 1;
  });
  return unique;
}

/** Whole-market snapshot: the desk's own venue when it has a bulk ticker
 * (`feed` = {exchange}), else the shared Binance US feed. Ranked by volume. */
export async function fetchMarkets(db = null, feed = null) {
  const venue = String((feed && feed.exchange) || "");
  const source = venue && venue !== "binance_us" && venue !== "binance" ? venue : "binance_us";
  const cacheKey = `markets:${source}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, capsDebug: -2 };

  if (source !== "binance_us") {
    let venueRows = [];
    try {
      venueRows = await fetchVenueMarkets(feed);
    } catch (err) {
      console.log(`${source} markets failed: ${err && err.message}`);
    }
    const venueCoins = await finalizeCoins(db, venueRows);
    if (venueCoins.length) {
      return cacheSet(
        cacheKey,
        { coins: venueCoins, source, capsDebug: venueCoins.some((c) => c.market_cap > 0) ? 1 : -1 },
        60000,
      );
    }
  }

  let rows = null;
  try {
    rows = await fetchJson(`${BASE}/ticker/24hr`, 20000);
  } catch (err) {
    console.log(`markets feed failed: ${err && err.message}`);
  }

  if (Array.isArray(rows) && rows.length) {
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

    // Real market caps (best effort): coins the cap feed has no data for stay
    // at 0 and are skipped when the bot picks candidates.
    const caps = await loadCaps(db);
    console.log(`caps loaded: ${caps ? caps.size : "none"}`);
    if (caps && caps.size) {
      for (const c of coins) c.market_cap = caps.get(c.symbol) || 0;
    }

    coins.forEach((c, i) => {
      c.bucket = tierFor(i);
      c.rank = i + 1;
    });

    if (coins.length) {
      saveMarketsToDb(db, coins);
      return cacheSet(
        cacheKey,
        { coins, source: "binance_us", capsDebug: caps && caps.size ? caps.size : -1 },
        60000,
      );
    }
  }

  // the live feed is down (rate limit or outage): serve the last good desk
  // snapshot instead of failing the whole cycle with a 500
  const slim = await readMarketsFromDb(db);
  if (slim) {
    const caps = await loadCaps(db);
    const coins = slim
      .map((s) => ({
        symbol: s[0],
        name: s[0],
        coingecko_id: "",
        image: "",
        price: Number(s[1]) || 0,
        market_cap: 0,
        volume24h: Number(s[2]) || 0,
        change24h: Number(s[3]) || 0,
        change7d: 0,
        rank: 0,
      }))
      .sort((a, b) => b.volume24h - a.volume24h);
    if (caps && caps.size) {
      for (const c of coins) c.market_cap = caps.get(c.symbol) || 0;
    }
    coins.forEach((c, i) => {
      c.bucket = tierFor(i);
      c.rank = i + 1;
    });
    console.log(`markets served from desk cache: ${coins.length} symbols`);
    return cacheSet(cacheKey, { coins, source: "desk_cache", capsDebug: -3 }, 60000);
  }
  throw new Error("The market feed is unavailable right now - try again shortly.");
}

/** OHLCV candles for one coin: from the desk's own venue when a `feed` is
 * given, else Binance US. Returns null when no pair has data. */
export async function fetchCandles(symbol, interval = "1h", limit = 300, feed = null, quote = "USD") {
  const venue = String((feed && feed.exchange) || "");
  const tag = venue && venue !== "binance_us" && venue !== "binance" ? venue : "us";
  // a quote-specific read keeps its own slot: a BTC chart and a USD chart of the
  // same coin are different series and must never share a cache entry
  const quoteTag = String(quote || "USD").toUpperCase() === "BTC" ? ":btc" : "";
  const key = `k:${tag}:${symbol}:${interval}:${limit}${quoteTag}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  if (tag !== "us") {
    const venueCandles = await fetchVenueCandles(feed, symbol, interval, limit, quote);
    if (venueCandles && venueCandles.length) return cacheSet(key, venueCandles, 45000);
  }
  // the US feed only quotes in USD: a BTC read never falls back to it
  if (quoteTag) return null;

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
export async function fetchCandlesHistory(symbol, interval = "1h", months = 6, endOffsetMonths = 0) {
  const key = `hist:${symbol}:${interval}:${months}:${endOffsetMonths}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // an end offset backdates the window: 6 months ending 6 months ago is the
  // earlier half of a 12-month test, run in two blocks to bound CPU
  let endMs = Date.now() - endOffsetMonths * 30 * 24 * 3600 * 1000;
  const startMs = endMs - months * 30 * 24 * 3600 * 1000;
  const pages = [];
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

  // coins only a KuCoin or Bybit account holds still get a live price, so a
  // wallet position is never valued at zero and never exits on a stale figure
  const stillMissing = wanted.filter((s) => !map.has(s));
  if (stillMissing.length) {
    const extra = await venuePriceFallback(stillMissing);
    for (const [sym, px] of extra) map.set(sym, px);
  }
  return cacheSet(key, map, 30000);
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}