// Kraken public market data - monthly candle history for the optimizer.
const KRAKEN_API = "https://api.kraken.com/0/public";

const store = new Map();
const TTL = 45000;

// Liquid Kraken USDT pairs, majors first. Symbol is the engine's coin symbol.
export const KRAKEN_PAIRS = [
  { pair: "XBTUSDT", symbol: "BTC" },
  { pair: "ETHUSDT", symbol: "ETH" },
  { pair: "SOLUSDT", symbol: "SOL" },
  { pair: "XRPUSDT", symbol: "XRP" },
  { pair: "ADAUSDT", symbol: "ADA" },
  { pair: "DOTUSDT", symbol: "DOT" },
  { pair: "LINKUSDT", symbol: "LINK" },
  { pair: "AVAXUSDT", symbol: "AVAX" },
  { pair: "LTCUSDT", symbol: "LTC" },
  { pair: "UNIUSDT", symbol: "UNI" },
  { pair: "ATOMUSDT", symbol: "ATOM" },
  { pair: "XDGUSDT", symbol: "DOGE" },
  { pair: "AAVEUSDT", symbol: "AAVE" },
  { pair: "ALGOUSDT", symbol: "ALGO" },
  { pair: "FILUSDT", symbol: "FIL" },
  { pair: "TRXUSDT", symbol: "TRX" },
  { pair: "ETCUSDT", symbol: "ETC" },
  { pair: "XTZUSDT", symbol: "XTZ" },
  { pair: "GRTUSDT", symbol: "GRT" },
];

export function krakenPairs() {
  return KRAKEN_PAIRS;
}

let marginCache = null;
let marginCacheAt = 0;

/**
 * Kraken margin-eligible pairs: the AssetPairs endpoint exposes each pair's
 * leverage ladder (an empty or missing list means spot only). Returns the
 * engine symbols of our tracked pairs that offer SELL leverage - the pairs
 * margin trading can actually short - cached for ten minutes.
 */
export async function fetchKrakenMarginSymbols() {
  if (marginCache && Date.now() - marginCacheAt < 600000) return marginCache;
  const j = await fetchJson(`${KRAKEN_API}/AssetPairs`);
  if (!j || (j.error && j.error.length)) return null;
  const out = [];
  for (const { pair, symbol } of KRAKEN_PAIRS) {
    const d = (j.result || {})[pair];
    if (d && (d.status || "online") === "online" && Array.isArray(d.leverage_sell) && d.leverage_sell.length)
      out.push(symbol);
  }
  marginCache = new Set(out);
  marginCacheAt = Date.now();
  return marginCache;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Kraken OHLC: up to 720 candles (a month of 1h data).
 * [time(s), open, high, low, close, vwap, volume, count] -> engine candle shape.
 */
export async function fetchKrakenCandles(pair, interval = 60, count = 720) {
  const key = `kraken:${pair}:${interval}:${count}`;
  const hit = store.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  const j = await fetchJson(`${KRAKEN_API}/OHLC?pair=${encodeURIComponent(pair)}&interval=${interval}`);
  if (!j || (j.error && j.error.length)) return null;
  const seriesKey = Object.keys(j.result || {}).find((k) => k !== "last");
  if (!seriesKey) return null;
  const raw = j.result[seriesKey] || [];
  const candles = raw
    .slice(-count)
    .map((r) => ({
      t: Number(r[0]) * 1000,
      o: parseFloat(r[1]),
      h: parseFloat(r[2]),
      l: parseFloat(r[3]),
      c: parseFloat(r[4]),
      v: parseFloat(r[6]),
    }))
    .filter((c) => Number.isFinite(c.c) && c.c > 0);
  store.set(key, { ts: Date.now(), data: candles });
  return candles;
}