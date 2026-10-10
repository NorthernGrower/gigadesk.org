// Market order execution for the supported exchanges. Server-side only: this
// module must never be imported from the frontend. Every request is bounded by
// a 10s timeout and refusals are returned as values, never thrown.
import { callJson, hmacHex, hmacB64, sha256Hex, b64ToBytes, enc, toBase64 } from "./exchanges.ts";
import { decryptSecret } from "./crypto.ts";
import { round } from "./market.ts";

export const QUOTE_ASSET = { binance_us: "USD", binance: "USDT", bybit: "USDT", kucoin: "USDT", kraken: "USDT" };

const trunc = (n, d) => {
  const f = 10 ** d;
  return Math.floor((Number(n) || 0) * f) / f;
};

/**
 * Places a spot market order on one connected exchange. `usd` is the quote
 * amount spent on a buy; `quantity` is the base amount sold on a close; `price`
 * backs the sizing on exchanges that quote in base units. Returns
 * {ok, order_id, filled_qty, avg_price, message} — ok:false on any refusal.
 */
export async function placeMarketOrder(cfg, params) {
  const side = params.side === "sell" ? "sell" : "buy";
  const pair = `${String(params.symbol || "").toUpperCase()}${QUOTE_ASSET[cfg.exchange] || "USDT"}`;
  if (cfg.exchange === "bybit") return bybitOrder(cfg, params, side, pair);
  if (cfg.exchange === "kucoin") return kucoinOrder(cfg, params, side, pair);
  if (cfg.exchange === "kraken") return krakenOrder(cfg, params, side, pair);
  return binanceOrder(cfg, params, side, pair);
}

/**
 * The connection the bot sends real orders to, plus a human reason when it
 * cannot — {conn, reason}. conn carries only the signing fields.
 */
export async function resolveLiveConnection(base44, config) {
  if (!config || config.real_orders_enabled !== true) return { conn: null, reason: "Real orders are off" };
  if (!config.real_connection_id) return { conn: null, reason: "No exchange account is selected for real orders" };
  const stored = await base44.entities.ExchangeConnection.get(config.real_connection_id).catch(() => null);
  if (!stored) return { conn: null, reason: "The selected exchange account is missing" };
  if (stored.status !== "connected" || stored.allow_trading !== true) {
    return { conn: null, reason: `${stored.label || stored.exchange} is not verified and enabled for trading` };
  }
  return {
    conn: {
      exchange: stored.exchange,
      label: stored.label || stored.exchange,
      testnet: Boolean(stored.testnet),
      api_key: stored.api_key,
      api_secret: await decryptSecret(stored.api_secret),
      passphrase: await decryptSecret(stored.passphrase || ""),
    },
    reason: null,
  };
}

// ---- Binance / Binance US (HMAC-SHA256 over the query string) ----
async function binanceOrder(cfg, { usd, quantity }, side, pair) {
  const base = cfg.testnet
    ? "https://testnet.binance.vision"
    : cfg.exchange === "binance_us"
      ? "https://api.binance.us"
      : "https://api.binance.com";
  const parts = [
    `symbol=${pair}`,
    `side=${side.toUpperCase()}`,
    `type=MARKET`,
    `timestamp=${Date.now()}`,
    `recvWindow=10000`,
  ];
  if (side === "buy") parts.push(`quoteOrderQty=${round(usd, 2)}`);
  else parts.push(`quantity=${trunc(quantity, 6)}`);
  const qs = parts.join("&");
  const signature = await hmacHex(cfg.api_secret, qs);
  const res = await callJson(`${base}/api/v3/order?${qs}&signature=${signature}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": cfg.api_key },
  });
  const data = res.data || {};
  if (res.ok && ["NEW", "FILLED", "PARTIALLY_FILLED"].includes(data.status)) {
    const filled = (data.fills || []).reduce(
      (a, f) => ({ qty: a.qty + (Number(f.qty) || 0), usd: a.usd + (Number(f.qty) || 0) * (Number(f.price) || 0) }),
      { qty: 0, usd: 0 },
    );
    return {
      ok: true,
      order_id: String(data.orderId || ""),
      filled_qty: round(filled.qty, 8),
      avg_price: filled.qty ? round(filled.usd / filled.qty, 6) : null,
      message: `Market ${side} sent to Binance`,
    };
  }
  return {
    ok: false,
    message: (data.msg && `Binance said: ${data.msg}`) || res.text || "no response from Binance",
  };
}

// ---- Bybit v5 (HMAC-SHA256 over timestamp + key + recvWindow + body) ----
async function bybitOrder(cfg, { usd, quantity, price }, side, pair) {
  const px = Number(price) || 0;
  const baseQty = side === "buy" ? (px ? usd / px : 0) : Number(quantity) || 0;
  if (!(baseQty > 0)) return { ok: false, message: "No usable price to size a market buy on Bybit" };
  const body = JSON.stringify({
    category: "spot",
    symbol: pair,
    side: side.toUpperCase(),
    orderType: "Market",
    marketUnit: "baseCoin",
    qty: String(trunc(baseQty, 6)),
  });
  const ts = String(Date.now());
  const sign = await hmacHex(ts + cfg.api_key + "10000" + body, cfg.api_secret);
  const res = await callJson(`${cfg.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com"}/v5/order`, {
    method: "POST",
    headers: {
      "X-BAPI-API-KEY": cfg.api_key,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": "10000",
      "X-BAPI-SIGN": sign,
      "Content-Type": "application/json",
    },
    body,
  });
  const data = res.data || {};
  const orderId = ((data.result || {}).orderId) || "";
  if (data.retCode === 0 && orderId) {
    return { ok: true, order_id: String(orderId), filled_qty: null, avg_price: null, message: `Market ${side} sent to Bybit` };
  }
  return { ok: false, message: `Bybit said: ${data.retMsg || res.text || "no response from Bybit"}` };
}

// ---- KuCoin (HMAC-SHA256 base64 signature + encrypted passphrase) ----
async function kucoinOrder(cfg, { symbol, usd, quantity }, side) {
  const base = cfg.testnet ? "https://sandbox.kucoin.com" : "https://api.kucoin.com";
  const endpoint = "/api/v1/orders";
  const payload = {
    clientOid: `bp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    side: side.toUpperCase(),
    symbol: `${String(symbol || "").toUpperCase()}-${QUOTE_ASSET[cfg.exchange] || "USDT"}`,
    type: "market",
  };
  if (side === "buy") payload.funds = String(round(usd, 2));
  else payload.size = String(trunc(quantity, 8));
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const sign = await hmacB64(cfg.api_secret, ts + "POST" + endpoint + body);
  const pass = await hmacB64(cfg.passphrase || "", cfg.api_secret);
  const res = await callJson(base + endpoint, {
    method: "POST",
    headers: {
      "KC-API-KEY": cfg.api_key,
      "KC-API-SIGN": sign,
      "KC-API-TIMESTAMP": ts,
      "KC-API-PASSPHRASE": pass,
      "KC-API-KEY-VERSION": "2",
      "Content-Type": "application/json",
    },
    body,
  });
  const data = res.data || {};
  const orderId = ((data.data || {}).orderId) || "";
  if (data.code === "200000" && orderId) {
    return { ok: true, order_id: String(orderId), filled_qty: null, avg_price: null, message: `Market ${side} sent to KuCoin` };
  }
  return { ok: false, message: `KuCoin said: ${data.msg || data.code || res.text || "no response from KuCoin"}` };
}

// ---- Kraken (HMAC-SHA512 over path + sha256(nonce + body)) ----
async function krakenOrder(cfg, { symbol, usd, quantity, price }, side) {
  const px = Number(price) || 0;
  const vol = trunc(side === "buy" ? (px ? usd / px : 0) : Number(quantity) || 0, 8);
  if (!(vol > 0)) return { ok: false, message: "No usable price to size a market order on Kraken" };
  const path = "/0/private/AddOrder";
  const nonce = String(Date.now() * 1000);
  const pair = `${String(symbol || "").toUpperCase()}USDT`;
  const body = `nonce=${nonce}&pair=${pair}&type=market&ordertype=market&side=${side}&volume=${vol}`;
  const inner = await sha256Hex(nonce + body);
  const key = await crypto.subtle.importKey("raw", b64ToBytes(cfg.api_secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sign = toBase64(await crypto.subtle.sign("HMAC", key, enc.encode(path + inner)));
  const res = await callJson(`https://api.kraken.com${path}`, {
    method: "POST",
    headers: {
      "API-Key": cfg.api_key,
      "API-Sign": sign,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = res.data || {};
  const failed = Array.isArray(data.error) ? data.error : [];
  const first = Object.values(((data.result || {}).orders) || {})[0];
  if (!failed.length && first) {
    return {
      ok: true,
      order_id: String(first.txid || first.orderid || ""),
      filled_qty: round(Number(first.vol_exec || first.vol) || 0, 8),
      avg_price: Number(first.price) ? round(Number(first.price), 6) : null,
      message: `Market ${side} sent to Kraken`,
    };
  }
  return { ok: false, message: `Kraken said: ${failed[0] || res.text || "no response from Kraken"}` };
}