// Signed account reads for the supported exchanges. Server-side only: this
// module must never be imported from the frontend. Every outbound request is
// bounded by a 10s timeout and errors are returned, never thrown.
import { cacheGet, cacheSet, fetchLivePrices, round } from "./market.ts";

// Venues whose margin API this desk can actually place a short through: a
// short is a margin order, so a spot-only account (Binance US, Bybit spot)
// could never fill one.
export const SHORT_VENUES = new Set(["kraken", "kucoin"]);

export const enc = new TextEncoder();

const toHex = (buf) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

export const b64ToBytes = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function hmac(secret, msg, hash) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(msg));
}

export const hmacHex = async (secret, msg, hash = "SHA-256") => toHex(await hmac(secret, msg, hash));
export const hmacB64 = async (secret, msg, hash = "SHA-256") => toBase64(await hmac(secret, msg, hash));

export const sha256Hex = async (msg) => toHex(await crypto.subtle.digest("SHA-256", enc.encode(msg)));

export async function callJson(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      // non-json body
    }
    return { ok: res.ok, status: res.status, data, text: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, data: null, text: (e && e.message) || "network error" };
  }
}

export const EXCHANGES = {
  binance_us: { name: "Binance US", needsPassphrase: false, testnet: false },
  binance: { name: "Binance", needsPassphrase: false, testnet: true },
  bybit: { name: "Bybit", needsPassphrase: false, testnet: true },
  // KuCoin retired its public sandbox: every key is verified against the live
  // account, so a testnet toggle would only send reads to a dead host (which
  // answers with an opaque "error code: 1016")
  kucoin: { name: "KuCoin", needsPassphrase: true, testnet: false },
  kraken: { name: "Kraken", needsPassphrase: false, testnet: false },
};

// ---- Failure backoff: a failed signed read counts toward Kraken's lockout
// counter, so every background reader must leave the key alone for a while
// after a failure instead of retrying it into a longer lock
// Kraken's raw code ("EGeneral:Temporary lockout") has usually been mapped to
// plain English by the time it reaches here ("temporarily locked") — match
// both, so a locked key really pauses long enough for the lock to clear
export const backoffMinutes = (message) =>
  /Temporary lockout|temporarily locked/i.test(String(message || "")) ? 16 : 3;
export const isBackedOff = (conn) =>
  Boolean(conn && conn.backoff_until && Date.parse(conn.backoff_until) > Date.now());
export const backoffUntil = (message) =>
  new Date(Date.now() + backoffMinutes(message) * 60000).toISOString();
// Two readers hitting the same key within seconds can trip the exchange's
// rate limiter, so a balance read that just happened is good enough
export const balanceJustRead = (conn) =>
  Boolean(conn && conn.balance_updated_at && Date.now() - Date.parse(conn.balance_updated_at) < 10000);

export async function readAccount(cfg) {
  if (cfg.exchange === "bybit") return bybitAccount(cfg);
  if (cfg.exchange === "kucoin") return kucoinAccount(cfg);
  if (cfg.exchange === "kraken") return krakenAccount(cfg);
  return binanceAccount(cfg);
}

const sortBalances = (list) =>
  list.filter((b) => b.total > 0).sort((a, b) => b.total - a.total);

/**
 * The base assets with an active spot pair on one exchange, for keeping the
 * bot's scan inside what the connected account can actually trade (10 min
 * cache). Returns null when the listing feed is unavailable — the caller then
 * scans the default universe rather than scanning nothing.
 */
export async function fetchListedSymbols(cfg, quotes = null) {
  try {
    const key = `listed:${cfg.exchange}:${cfg.testnet ? "testnet" : "live"}:${(quotes || []).slice().sort().join(",")}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    let set = null;
    // optional narrowing to the quote currency the account actually funds
    // orders with (USD, USDT or USDC) — null keeps the exchange's default
    const wanted = quotes && quotes.length ? quotes.map((q) => String(q).toUpperCase()) : null;
    if (cfg.exchange === "binance" || cfg.exchange === "binance_us") {
      const base = cfg.testnet
        ? "https://testnet.binance.vision"
        : cfg.exchange === "binance_us"
          ? "https://api.binance.us"
          : "https://api.binance.com";
      const res = await callJson(`${base}/api/v3/exchangeInfo`);
      const rows = ((res.data || {}).symbols) || [];
      // the bot's data feed and order pairs quote in USDT (USD on Binance US)
      const quotesList = wanted || (cfg.exchange === "binance_us" ? ["USD", "USDT"] : ["USDT"]);
      set = new Set(
        rows
          .filter((s) => s.status === "TRADING" && quotesList.includes(s.quoteAsset))
          .map((s) => String(s.baseAsset || "").toUpperCase())
          .filter(Boolean),
      );
    } else if (cfg.exchange === "bybit") {
      const base = cfg.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
      set = new Set();
      let cursor = "";
      for (let page = 0; page < 5; page++) {
        const res = await callJson(
          `${base}/v5/market/instruments-info?category=spot&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        const result = (res.data || {}).result || {};
        for (const s of result.list || []) {
          for (const q of wanted || ["USDT"]) {
            if (s.status === "Trading" && String(s.symbol || "").endsWith(q))
              set.add(String(s.symbol).slice(0, -q.length).toUpperCase());
          }
        }
        cursor = result.nextPageCursor || "";
        if (!cursor) break;
      }
    } else if (cfg.exchange === "kucoin") {
      const base = "https://api.kucoin.com";
      const res = await callJson(`${base}/api/v1/market/allTickers`);
      const tickers = ((res.data || {}).ticker) || [];
      set = new Set(
        tickers
          .map((t) => String(t.symbol || ""))
          .filter((s) => (wanted || ["USDT"]).some((q) => s.endsWith(`-${q}`)))
          .map((s) => s.split("-")[0].toUpperCase())
          .filter(Boolean),
      );
    } else if (cfg.exchange === "kraken") {
      const res = await callJson("https://api.kraken.com/0/public/AssetPairs");
      const pairs = Object.values(((res.data || {}).result) || {});
      const rawQuotes = new Set((wanted || ["USDT"]).map((q) => ({ USD: "ZUSD", EUR: "ZEUR", GBP: "ZGBP" }[q] || q)));
      set = new Set(
        pairs
          .filter((p) => p && rawQuotes.has(p.quote))
          .map((p) => krakenAsset(p.base).toUpperCase())
          .filter(Boolean),
      );
    }
    if (set && set.size) return cacheSet(key, set, 10 * 60 * 1000);
    return set;
  } catch (err) {
    console.log(`listed symbols for ${cfg.exchange} failed: ${err && err.message}`);
    return null;
  }
}

/**
 * Exchange trading constraints per pair: minimum order size, quantity step and
 * minimum order value, so orders are rounded to what the exchange accepts
 * (10 min cache). Returns null when the feed is unavailable — orders then fall
 * back to the desk's own rounding.
 */
export async function fetchMarketConstraints(cfg) {
  try {
    const key = `constraints:${cfg.exchange}:${cfg.testnet ? "testnet" : "live"}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const map = new Map();
    if (cfg.exchange === "binance" || cfg.exchange === "binance_us") {
      const base = cfg.testnet
        ? "https://testnet.binance.vision"
        : cfg.exchange === "binance_us"
          ? "https://api.binance.us"
          : "https://api.binance.com";
      const res = await callJson(`${base}/api/v3/exchangeInfo`);
      for (const s of ((res.data || {}).symbols) || []) {
        if (s.status !== "TRADING") continue;
        const filters = s.filters || [];
        const lot = filters.find((f) => f.filterType === "LOT_SIZE") || {};
        const notion = filters.find((f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL") || {};
        map.set(s.symbol, {
          minQty: Number(lot.minQty) || null,
          qtyStep: Number(lot.stepSize) || null,
          minNotional: Number(notion.minNotional) || null,
        });
      }
    } else if (cfg.exchange === "bybit") {
      const base = cfg.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
      let cursor = "";
      for (let page = 0; page < 5; page++) {
        const res = await callJson(
          `${base}/v5/market/instruments-info?category=spot&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        const result = (res.data || {}).result || {};
        for (const s of result.list || []) {
          const lot = s.lotSizeFilter || {};
          map.set(String(s.symbol || ""), {
            minQty: Number(lot.minOrderQty) || null,
            qtyStep: Number(lot.qtyStep) || null,
            minNotional: Number(lot.minNotionalValue) || null,
          });
        }
        cursor = result.nextPageCursor || "";
        if (!cursor) break;
      }
    } else if (cfg.exchange === "kucoin") {
      const base = "https://api.kucoin.com";
      const res = await callJson(`${base}/api/v1/symbols`);
      for (const s of Array.isArray(res.data) ? res.data : []) {
        if (s.enableTrading === false) continue;
        const pair = `${String(s.baseCurrency || "").toUpperCase()}${String(s.quoteCurrency || "").toUpperCase()}`;
        map.set(pair, {
          minQty: Number(s.baseMinSize) || null,
          qtyStep: Number(s.baseIncrement) || null,
          minNotional: Number(s.quoteMinSize) || null,
        });
      }
    } else if (cfg.exchange === "kraken") {
      const res = await callJson("https://api.kraken.com/0/public/AssetPairs");
      const pairs = Object.values(((res.data || {}).result) || {});
      for (const p of pairs) {
        if (!p) continue;
        const quote = { ZUSD: "USD", USDT: "USDT", USDC: "USDC" }[p.quote];
        if (!quote) continue;
        map.set(`${krakenAsset(p.base).toUpperCase()}${quote}`, {
          minQty: Number(p.ordermin) || null,
          qtyStep: 10 ** -(Number(p.lot_decimals) || 8),
          minNotional: null,
        });
      }
    }
    if (map.size) return cacheSet(key, map, 10 * 60 * 1000);
    return null;
  } catch (err) {
    console.log(`market constraints for ${cfg.exchange} failed: ${err && err.message}`);
    return null;
  }
}

// ---- Binance / Binance US (HMAC-SHA256 over the query string) ----
async function binanceAccount(cfg) {
  const base = cfg.testnet
    ? "https://testnet.binance.vision"
    : cfg.exchange === "binance_us"
      ? "https://api.binance.us"
      : "https://api.binance.com";
  const qs = `timestamp=${Date.now()}&recvWindow=10000`;
  const signature = await hmacHex(cfg.api_secret, qs);
  const res = await callJson(`${base}/api/v3/account?${qs}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": cfg.api_key },
  });
  const data = res.data || {};
  if (Array.isArray(data.balances)) {
    return {
      ok: true,
      canTrade: data.canTrade === true,
      message: "Key verified with a live account read",
      balances: sortBalances(
        data.balances.map((b) => ({
          asset: b.asset,
          total: (Number(b.free) || 0) + (Number(b.locked) || 0),
        })),
      ),
    };
  }
  const code = data.code;
  const message =
    code === -2014 || code === -2015
      ? `The exchange rejected this key (${data.msg || "invalid key, wrong permissions, or IP restrictions"})`
      : (data.msg && `${base} said: ${data.msg}`) || res.text || "no response from the exchange";
  return { ok: false, canTrade: null, message, balances: [] };
}

// ---- Bybit v5 (HMAC-SHA256 over timestamp + key + recvWindow + query) ----
async function bybitAccount(cfg) {
  const base = cfg.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
  const attempt = async (accountType) => {
    const ts = String(Date.now());
    const recv = "10000";
    const query = `accountType=${accountType}`;
    const sign = await hmacHex(ts + cfg.api_key + recv + query, cfg.api_secret);
    return callJson(`${base}/v5/account/wallet-balance?${query}`, {
      headers: {
        "X-BAPI-API-KEY": cfg.api_key,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": recv,
        "X-BAPI-SIGN": sign,
      },
    });
  };
  let res = await attempt("UNIFIED");
  const firstCode = (res.data || {}).retCode;
  if (firstCode !== 0) {
    const retry = await attempt("SPOT");
    if ((retry.data || {}).retCode === 0) res = retry;
  }
  const data = res.data || {};
  const list = ((data.result || {}).list || [])[0];
  if (data.retCode === 0 && list) {
    return {
      ok: true,
      canTrade: null,
      message: "Key verified with a live account read",
      balances: sortBalances(
        (list.coin || []).map((c) => ({ asset: c.coin, total: Number(c.walletBalance) || 0 })),
      ),
    };
  }
  return {
    ok: false,
    canTrade: null,
    message: `Bybit error: ${data.retMsg || res.text || "no response from the exchange"}`,
    balances: [],
  };
}

// ---- KuCoin (HMAC-SHA256 base64 signatures + encrypted passphrase) ----
// KuCoin splits funds across wallets: spot sits in the main and trade accounts,
// a cross-margin account holds short collateral. The default account list
// returns one row per currency per wallet type, so reading it flat made the desk
// see a slice of each currency (funding sized off a partial balance) and hid the
// margin account entirely. Both are read here and merged per currency:
// `total` is the whole holding shown on the desk, `spot` the part an order can
// spend without moving funds first.
// KuCoin's raw codes are terse; map the common ones to plain advice.
const KUCOIN_MESSAGES = {
  "400001": "KuCoin rejected the API key — check it was copied in full",
  "400002": "KuCoin rejected the signature — the API secret looks wrong or incomplete",
  "400003": "KuCoin rejected the API passphrase, or the key was created for a different KuCoin site",
  "400004": "KuCoin rejected the API key version — recreate the key on KuCoin and paste its new passphrase",
  "400005": "KuCoin does not recognise this API key — check it was copied in full",
  "400006": "KuCoin rejected the request's IP address — add the desk's IP to the key's whitelist, or remove the whitelist",
  "400007": "The key is missing permission to read the account (enable General permission on the key)",
};

async function kucoinAccount(cfg) {
  const base = "https://api.kucoin.com";
  const get = async (path) => {
    const ts = String(Date.now());
    const sign = await hmacB64(cfg.api_secret, ts + "GET" + path);
    const pass = await hmacB64(cfg.passphrase || "", cfg.api_secret);
    return callJson(base + path, {
      headers: {
        "KC-API-KEY": cfg.api_key,
        "KC-API-SIGN": sign,
        "KC-API-TIMESTAMP": ts,
        "KC-API-PASSPHRASE": pass,
        "KC-API-KEY-VERSION": "2",
      },
    });
  };
  const res = await get("/api/v1/accounts");
  const data = res.data || {};
  if (data.code !== "200000" || !Array.isArray(data.data)) {
    return {
      ok: false,
      canTrade: null,
      message: `KuCoin error: ${KUCOIN_MESSAGES[String(data.code || "")] || data.msg || data.code || res.text || "no response from the exchange"}`,
      balances: [],
    };
  }
  const totals = new Map();
  for (const a of data.data) {
    const asset = String(a.currency || "").toUpperCase();
    if (!asset) continue;
    const row = totals.get(asset) || { asset, spot: 0, total: 0 };
    const amount = Number(a.total) || 0;
    row.spot += amount;
    row.total += amount;
    totals.set(asset, row);
  }
  // cross-margin wallet (best effort: a key without margin permission still
  // returns a correct spot balance)
  try {
    const margin = await get("/api/v1/accounts?type=margin");
    const m = margin.data || {};
    if (m.code === "200000" && Array.isArray(m.data)) {
      for (const a of m.data) {
        const asset = String(a.currency || "").toUpperCase();
        if (!asset) continue;
        const row = totals.get(asset) || { asset, spot: 0, total: 0 };
        // margin rows report gross holdings beside the borrowed amount: only
        // the net is the account's own money, so a short's borrowed asset never
        // inflates the value the desk shows
        row.total += Math.max(0, (Number(a.total) || 0) - (Number(a.liability) || 0));
        totals.set(asset, row);
      }
    }
  } catch (err) {
    console.log(`kucoin margin accounts unavailable: ${err && err.message}`);
  }
  return {
    ok: true,
    canTrade: null,
    message: "Key verified with a live account read",
    balances: sortBalances(
      [...totals.values()].map((b) => ({
        asset: b.asset,
        total: round(b.total, 8),
        spot: round(b.spot, 8),
      })),
    ),
  };
}

// ---- Kraken (HMAC-SHA512 over path + sha256(nonce + body)) ----
const KRAKEN_ASSETS = {
  XXBT: "BTC",
  XBT: "BTC",
  XETH: "ETH",
  XXDG: "DOGE",
  XDG: "DOGE",
  ZUSD: "USD",
  ZEUR: "EUR",
  ZCAD: "CAD",
  ZGBP: "GBP",
  XXRP: "XRP",
  XLTC: "LTC",
  XXLM: "XLM",
  XZEC: "ZEC",
  SOL: "SOL",
};

export const krakenAsset = (a) => KRAKEN_ASSETS[a] || a;

// Kraken rejects any request whose nonce is not strictly above the previous
// one — two signed calls landing in the same millisecond would collide, and
// every rejection counts toward the temporary lockout. Bump past whatever
// this server last issued.
let lastKrakenNonce = 0;
export const krakenNonce = () =>
  (lastKrakenNonce = Math.max(Date.now() * 1000, lastKrakenNonce + 1));

// Kraken's signature is HMAC-SHA512 over the URI path plus the RAW bytes of
// sha256(nonce + post body). Encoding the digest as a hex string made every
// signed request fail (EAPI:Invalid key), and the desk's repeated connection
// checks then piled the failures into EGeneral:Temporary lockout.
export async function krakenSign(secretB64, path, nonce, body) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(nonce + body)));
  const pathBytes = enc.encode(path);
  const msg = new Uint8Array(pathBytes.length + digest.length);
  msg.set(pathBytes);
  msg.set(digest, pathBytes.length);
  const key = await crypto.subtle.importKey("raw", b64ToBytes(secretB64), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return toBase64(await crypto.subtle.sign("HMAC", key, msg));
}

// Kraken's raw error codes are terse; map the common ones to plain advice.
export const KRAKEN_MESSAGES = {
  "EAPI:Invalid key": "Kraken rejected the API key — check it was copied in full",
  "EAPI:Invalid signature": "Kraken rejected the signature — the API secret looks wrong or incomplete",
  "EAPI:Invalid nonce": "Kraken rejected the request as repeated or too old — try again in a moment",
  "EAPI:Invalid permission": "The key is missing the permission to read account funds (enable Query Funds on the key)",
  "EGeneral:Permission denied": "The key is missing permission to read the account balance",
  "EGeneral:Temporary lockout": "Kraken temporarily locked this key after repeated failed attempts — wait about 15 minutes, then reconnect",
};

// Serialize every signed Kraken call this process makes and space them a
// little apart: when the user returns after time away the desk fires a burst
// of signed reads and orders at once, and two landing in the same instant
// get handed the same nonce (or land inside Kraken's per-key request window)
// — each rejection counts toward Kraken's 15-minute temporary lockout.
// Kraken's limiter refills its per-key counter roughly one request every
// 0.3-1s (tier-dependent) and every rejected call still counts — a fast
// spacing full of rejected pages spirals into a temporary lockout. 1.5s
// keeps sustained traffic (the hourly history pull included) under it.
const KRAKEN_SPACING_MS = 1500;
let krakenChain = Promise.resolve();
let lastKrakenSentAt = 0;
export async function withKrakenSlot(task) {
  const slot = krakenChain.then(async () => {
    const gap = lastKrakenSentAt + KRAKEN_SPACING_MS - Date.now();
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    lastKrakenSentAt = Date.now();
  });
  krakenChain = slot.catch(() => {});
  await slot;
  return task();
}

export async function krakenSignedCall(cfg, path, extraBody = "") {
  // a nonce-rejected call was refused before Kraken processed it, never
  // executed, so retrying with a strictly higher nonce is safe
  for (let attempt = 0; ; attempt++) {
    const res = await withKrakenSlot(async () => {
      const nonce = krakenNonce() + attempt * 1000000;
      const body = `nonce=${nonce}${extraBody}`;
      const sign = await krakenSign(cfg.api_secret, path, String(nonce), body);
      return callJson(`https://api.kraken.com${path}`, {
        method: "POST",
        headers: {
          "API-Key": cfg.api_key,
          "API-Sign": sign,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
    });
    const failed = res.data && Array.isArray(res.data.error) ? res.data.error : [];
    if (failed.includes("EAPI:Invalid nonce") && attempt < 2) continue;
    return res;
  }
}

async function krakenCall(cfg, nonce) {
  return krakenSignedCall(cfg, "/0/private/Balance");
}

async function krakenAccount(cfg) {
  // two server processes can mint the same millisecond nonce and Kraken
  // rejects the second as repeated (and counts it toward the lockout), so a
  // nonce rejection is retried once with a strictly higher value
  let res = await krakenCall(cfg, String(krakenNonce()));
  let data = res.data || {};
  let failed = Array.isArray(data.error) ? data.error : [];
  if (failed.includes("EAPI:Invalid nonce")) {
    res = await krakenCall(cfg, String(krakenNonce() + 1000000));
    data = res.data || {};
    failed = Array.isArray(data.error) ? data.error : [];
  }
  if (res.data && data.result && failed.length === 0) {
    return {
      ok: true,
      canTrade: null,
      message: "Key verified with a live account read",
      balances: sortBalances(
        Object.entries(data.result)
          .filter(([asset]) => !asset.startsWith(".") && !asset.includes(".HOLD"))
          .map(([asset, amount]) => ({ asset: krakenAsset(asset), total: Number(amount) || 0 })),
      ),
    };
  }
  const code = failed[0] || "";
  return {
    ok: false,
    canTrade: null,
    message: `Kraken error: ${KRAKEN_MESSAGES[code] || code || res.text || "no response from the exchange"}`,
    balances: [],
  };
}

// Quote-currency variants an exchange may hold a cash balance in. The first
// asset each exchange lists is its native quote; the rest are accepted
// substitutes so a user funded in a different stable still gets a balance.
export const QUOTE_ALIASES = {
  binance_us: ["USD", "USDT", "USDC"],
  binance: ["USDT", "USDC", "USD"],
  bybit: ["USDT", "USDC", "USD"],
  kucoin: ["USDT", "USDC", "USD"],
  kraken: ["USD", "USDT", "USDC"],
};

/**
 * Picks the quote balance from an account read and converts it to USD.
 * Preference order: the exchange's native quote (e.g. USD on Kraken /
 * Binance US), then the other dollar stables, then other fiat the account
 * may be funded in (CAD, EUR, GBP — converted at the live rate). Returns
 * 0 only when the account holds none of them.
 */
export async function pickQuoteBalance(balances = [], exchange) {
  const list = (balances || []).map((b) => ({
    asset: String(b.asset || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
    total: Number(b.total) || 0,
  }));
  const order = [
    ...(QUOTE_ALIASES[exchange] || []),
    "USDT", "USDC", "USD",
    "CAD", "EUR", "GBP",
  ];
  const seen = new Set();
  for (const asset of order) {
    if (seen.has(asset)) continue;
    seen.add(asset);
    const row = list.find((b) => b.asset === asset && b.total > 0);
    if (!row) continue;
    const rate = await fiatToUsdRate(asset);
    return Math.round(row.total * rate * 100) / 100;
  }
  // nothing named exactly like a known quote: accept a suffix variant so an
  // unexpected naming (e.g. USDC_MERGED) still shows a balance
  const fallback = list
    .filter((b) => /^(USD|USDT|USDC|CAD|EUR|GBP)[0-9A-Z]*$/.test(b.asset) && b.total > 0)
    .sort((a, b) => b.total - a.total)[0];
  if (!fallback) return 0;
  const rate = await fiatToUsdRate(fallback.asset.slice(0, 3));
  return Math.round(fallback.total * rate * 100) / 100;
}

/**
 * The balance held in the exchange's native quote asset — the currency its
 * pairs actually settle in (USD on Kraken / Binance US, USDT elsewhere).
 * Fiat held in another currency (e.g. CAD on Kraken) converts into a display
 * figure but can never fund an order there, so ordering paths must read this,
 * not the converted balance. Returns 0 when the account holds none.
 */
export async function pickNativeQuoteBalance(balances = [], exchange) {
  const native = (QUOTE_ALIASES[exchange] || ["USDT"])[0];
  const row = (balances || []).find(
    (b) => String(b.asset || "").toUpperCase() === native && spendable(b) > 0,
  );
  return row ? Math.round(spendable(row) * 100) / 100 : 0;
}

/**
 * What an order can actually spend of a holding: the spot wallets when the
 * venue reports them separately (KuCoin keeps margin collateral in its own
 * wallet), else the whole holding.
 */
const spendable = (b) => {
  const spot = Number(b && b.spot);
  if (Number.isFinite(spot) && spot > 0) return spot;
  return Number(b && b.total) || 0;
};

/**
 * The asset the account can actually fund orders with, in preference order:
 * the exchange's native quote, then the other stables its pairs settle in —
 * USD, then USDT on Kraken. Fiat in another currency (CAD, EUR, GBP) can
 * never fund an order there. Returns null when the account holds none.
 */
export function pickFundingQuote(balances = [], exchange) {
  const order = exchange === "kraken" ? ["USD", "USDT", "USDC"] : (QUOTE_ALIASES[exchange] || ["USDT"]);
  for (const asset of order) {
    const row = (balances || []).find(
      (b) => String(b.asset || "").toUpperCase() === asset && spendable(b) > 0,
    );
    if (row) return { asset, amount: Math.round(spendable(row) * 100) / 100 };
  }
  return null;
}

/**
 * The account's TOTAL value in USD: every holding priced, not just the quote
 * cash — so the desk's balance matches what the exchange app shows. Kraken
 * prices the whole account itself on TradeBalance ("eb", combined balance of
 * every currency converted to the requested asset), which is the durable
 * source: no external price feed to go stale. Other exchanges (and a Kraken
 * fallback) value each asset: quote stables 1:1, fiat at the FX rate, crypto
 * at live exchange prices — an asset no feed prices contributes 0.
 */
export async function accountValueUsd(cfg, balances = [], opts = {}) {
  if (cfg && cfg.exchange === "kraken" && !opts.skipSigned) {
    const res = await krakenSignedCall(cfg, "/0/private/TradeBalance", "&asset=ZUSD");
    const data = res.data || {};
    const failed = Array.isArray(data.error) ? data.error : [];
    const eb = data.result ? Number(data.result.eb) : NaN;
    if (failed.length === 0 && Number.isFinite(eb)) return Math.round(eb * 100) / 100;
    // the endpoint can be refused (key permission, transient) — fall through
    // to per-asset pricing rather than showing nothing
  }
  const list = (balances || [])
    .map((b) => ({
      asset: String(b.asset || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
      total: Number(b.total) || 0,
    }))
    .filter((b) => b.total > 0);
  if (!list.length) return 0;
  let total = 0;
  const crypto = [];
  for (const b of list) {
    if (["USD", "USDT", "USDC"].includes(b.asset)) total += b.total;
    else if (["CAD", "EUR", "GBP"].includes(b.asset)) total += b.total * (await fiatToUsdRate(b.asset));
    else crypto.push(b);
  }
  if (crypto.length) {
    const prices = await fetchLivePrices(crypto.map((b) => b.asset), "USDT");
    for (const b of crypto) total += b.total * (prices.get(b.asset) || 0);
  }
  return Math.round(total * 100) / 100;
}

// USD conversion rate for fiat quote currencies, cached for an hour.
const FIAT = new Set(["CAD", "EUR", "GBP"]);
const fiatToUsdRate = async (asset) => {
  if (!FIAT.has(asset)) return 1; // USD and dollar stables are 1:1
  const key = `fx_${asset}`;
  const cached = cacheGet(key);
  if (cached != null) return cached;
  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=${asset}&to=USD`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    const rate = Number(data?.rates?.USD);
    if (rate > 0 && isFinite(rate)) return cacheSet(key, rate, 60 * 60 * 1000);
  } catch {
    // offline or blocked: fall through
  }
  return 1; // fail-open so a dead FX source never zeroes the balance
};