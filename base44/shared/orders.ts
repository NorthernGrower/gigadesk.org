// Market order execution for the supported exchanges. Server-side only: this
// module must never be imported from the frontend. Every request is bounded by
// a 10s timeout and refusals are returned as values, never thrown.
import { callJson, hmacHex, hmacB64, sha256Hex, b64ToBytes, enc, toBase64, krakenSign, krakenNonce, KRAKEN_MESSAGES, fetchMarketConstraints } from "./exchanges.ts";
import { decryptSecret } from "./crypto.ts";
import { round } from "./market.ts";

export const QUOTE_ASSET = { binance_us: "USD", binance: "USDT", bybit: "USDT", kucoin: "USDT", kraken: "USD" };

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
/** Idempotent order key: a retried or timed-out submission inside the same
 * minute window resolves to the same client order id, so the exchange dedupes
 * it instead of opening a duplicate position. */
function idemKey(symbol) {
  return `gd${Math.floor(Date.now() / 60000).toString(36)}${String(symbol || "").toUpperCase()}`.slice(0, 32);
}

/**
 * Exchange-level guards: round the quantity to the market's step and refuse
 * anything below the market's minimum size or order value.
 */
async function guardConstraints(cfg, { usd, quantity, price, side, pair }) {
  const cons = await fetchMarketConstraints(cfg);
  const m = cons ? cons.get(pair) : null;
  if (!m) return { ok: true };
  if (side === "buy") {
    const spend = Number(usd) || 0;
    if (m.minNotional && spend < m.minNotional) {
      return { ok: false, message: `Order of ${round(spend, 2)} is below ${pair}'s minimum order value of ${m.minNotional}` };
    }
    return { ok: true, usd: spend };
  }
  let qty = Number(quantity) || 0;
  if (m.qtyStep && m.qtyStep > 0) qty = Math.floor(qty / m.qtyStep) * m.qtyStep;
  if (m.minQty && qty < m.minQty) {
    return { ok: false, message: `Order quantity ${round(qty, 8)} is below ${pair}'s minimum of ${m.minQty}` };
  }
  if (m.minNotional && price && qty * price < m.minNotional) {
    return { ok: false, message: `Order value is below ${pair}'s minimum order value of ${m.minNotional}` };
  }
  return { ok: true, quantity: qty };
}

export async function placeMarketOrder(cfg, params) {
  const side = params.side === "sell" ? "sell" : "buy";
  const pair = `${String(params.symbol || "").toUpperCase()}${QUOTE_ASSET[cfg.exchange] || "USDT"}`;
  const idem = idemKey(params.symbol);
  if (cfg.exchange === "bybit") return bybitOrder(cfg, params, side, pair, idem);
  if (cfg.exchange === "kucoin") return kucoinOrder(cfg, params, side, pair, idem);
  if (cfg.exchange === "kraken") return krakenOrder(cfg, params, side, pair, idem);
  return binanceOrder(cfg, params, side, pair, idem);
}

/**
 * The connection the bot sends real orders to, plus a human reason when it
 * cannot — {conn, reason}. conn carries only the signing fields.
 */
export async function resolveLiveConnection(base44, config, opts = {}) {
  const manage = opts.manage === true;
  if (!config) return { conn: null, reason: "No bot rules found", info: null };
  // managing open real positions must keep working while new live entries
  // are paused — the entry gate below is what honours the pause
  if (!manage && config.real_orders_enabled !== true) {
    return { conn: null, reason: "Live trading is paused", info: null };
  }
  if (!config.real_connection_id) {
    return { conn: null, reason: "No exchange account is selected for real orders", info: null };
  }
  // credential fields are hidden from every client-side read, so this read
  // goes through the service role — with an owner check, since the row rules
  // no longer apply here
  const stored = await base44.asServiceRole.entities.ExchangeConnection
    .get(config.real_connection_id)
    .catch(() => null);
  if (!stored || (config.created_by_id && stored.created_by_id !== config.created_by_id)) {
    return { conn: null, reason: "The selected exchange account is missing", info: null };
  }
  const info = {
    label: stored.label || stored.exchange,
    exchange: stored.exchange,
    status: stored.status,
    status_message: stored.status_message || "",
    allow_trading: stored.allow_trading === true,
    last_checked_at: stored.last_checked_at || null,
    // the last saved balance travels with the status, so a desk showing an
    // errored or locked connection keeps its last known figure
    balance_usd: stored.balance_usd != null ? Number(stored.balance_usd) : null,
    balance_updated_at: stored.balance_updated_at || null,
  };
  if (stored.status !== "connected" || stored.allow_trading !== true) {
    return { conn: null, reason: `${info.label} is not verified and enabled for trading`, info };
  }
  return {
    conn: {
      id: stored.id,
      exchange: stored.exchange,
      label: info.label,
      testnet: Boolean(stored.testnet),
      api_key: await decryptSecret(stored.api_key),
      api_secret: await decryptSecret(stored.api_secret),
      passphrase: await decryptSecret(stored.passphrase || ""),
    },
    reason: null,
    info,
  };
}

// ---- Binance / Binance US (HMAC-SHA256 over the query string) ----
async function binanceOrder(cfg, { usd, quantity, price }, side, pair, idem) {
  const guard = await guardConstraints(cfg, { usd, quantity, price, side, pair });
  if (!guard.ok) return { ok: false, message: guard.message };
  const base = cfg.testnet
    ? "https://testnet.binance.vision"
    : cfg.exchange === "binance_us"
      ? "https://api.binance.us"
      : "https://api.binance.com";
  const parts = [
    `symbol=${pair}`,
    `side=${side.toUpperCase()}`,
    `type=MARKET`,
    `newClientOrderId=${idem}`,
    `timestamp=${Date.now()}`,
    `recvWindow=10000`,
  ];
  if (side === "buy") parts.push(`quoteOrderQty=${round(guard.usd != null ? guard.usd : usd, 2)}`);
  else parts.push(`quantity=${trunc(guard.quantity != null ? guard.quantity : quantity, 6)}`);
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
async function bybitOrder(cfg, { usd, quantity, price }, side, pair, idem) {
  const px = Number(price) || 0;
  const guard = await guardConstraints(cfg, { usd, quantity, price, side, pair });
  if (!guard.ok) return { ok: false, message: guard.message };
  const baseQty = side === "buy" ? (px ? usd / px : 0) : Number(guard.quantity != null ? guard.quantity : quantity) || 0;
  if (!(baseQty > 0)) return { ok: false, message: "No usable price to size a market buy on Bybit" };
  const body = JSON.stringify({
    category: "spot",
    symbol: pair,
    side: side.toUpperCase(),
    orderType: "Market",
    marketUnit: "baseCoin",
    qty: String(trunc(baseQty, 6)),
    orderLinkId: idem,
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
async function kucoinOrder(cfg, { symbol, usd, quantity }, side, pair, idem) {
  const base = cfg.testnet ? "https://sandbox.kucoin.com" : "https://api.kucoin.com";
  const endpoint = "/api/v1/orders";
  const payload = {
    clientOid: idem,
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
async function krakenOrder(cfg, { symbol, usd, quantity, price, validate }, side, pair, idem) {
  const px = Number(price) || 0;
  const guard = await guardConstraints(cfg, { usd, quantity, price, side, pair });
  if (!guard.ok) return { ok: false, message: guard.message };
  const vol = trunc(
    side === "buy" ? (px ? usd / px : 0) : Number(guard.quantity != null ? guard.quantity : quantity) || 0,
    8,
  );
  if (!(vol > 0)) return { ok: false, message: "No usable price to size a market order on Kraken" };
  const path = "/0/private/AddOrder";
  const nonce = String(krakenNonce());
  // Kraken's `type` is the direction (buy/sell) and `ordertype` is market —
  // anything else comes back as EGeneral:Invalid arguments:type
  const body = `nonce=${nonce}&pair=${pair}&type=${side}&ordertype=market&volume=${vol}${validate ? "&validate=true" : ""}`;
  const sign = await krakenSign(cfg.api_secret, path, nonce, body);
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
  // AddOrder answers with result.txid (an array of order ids), not an orders map
  const result = data.result || {};
  const txid = Array.isArray(result.txid) ? result.txid[0] : result.txid;
  if (!failed.length && txid) {
    return {
      ok: true,
      order_id: String(txid),
      filled_qty: vol,
      avg_price: null,
      message: `Market ${side} sent to Kraken`,
    };
  }
  return { ok: false, message: `Kraken said: ${KRAKEN_MESSAGES[failed[0] || ""] || failed[0] || res.text || "no response from Kraken"}` };
}