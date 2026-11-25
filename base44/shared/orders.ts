// Market order execution for the supported exchanges. Server-side only: this
// module must never be imported from the frontend. Every request is bounded by
// a 10s timeout and refusals are returned as values, never thrown.
import { callJson, hmacHex, hmacB64, sha256Hex, b64ToBytes, enc, toBase64, kucoinAuthHeaders, krakenSign, krakenNonce, krakenSignedCall, withKrakenSlot, KRAKEN_MESSAGES, fetchMarketConstraints, readAccount } from "./exchanges.ts";
import { decryptSecret } from "./crypto.ts";
import { round, fetchLivePrices } from "./market.ts";

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
    // a buy can be sized by quote amount or, when closing a margin short, by
    // the base quantity recorded on the position
    const spend = Number(usd) || (price && Number(quantity) > 0 ? Number(quantity) * price : 0);
    if (m.minNotional && spend < m.minNotional) {
      return { ok: false, message: `Order of ${round(spend, 2)} is below ${pair}'s minimum order value of ${m.minNotional}` };
    }
    // the lot minimum applies to buys too: a buy sized below it is refused
    // ('volume minimum not met') and every failed signed call counts toward
    // the exchange's temporary lockout, so refuse it here without one
    if (price && m.minQty && spend / price < m.minQty) {
      return { ok: false, message: `Order of ${round(spend, 2)} buys less than ${pair}'s minimum of ${m.minQty} units at ${round(price, 8)}` };
    }
    return { ok: true, usd: spend };
  }
  // a margin short open sells a USD amount (no base quantity on hand): the
  // volume is derived from the price like a buy's
  let qty = Number(quantity) || (price && Number(usd) > 0 ? Number(usd) / price : 0);
  if (m.qtyStep && m.qtyStep > 0) qty = Math.floor(qty / m.qtyStep) * m.qtyStep;
  if (m.minQty && qty < m.minQty) {
    return { ok: false, message: `Order quantity ${round(qty, 8)} is below ${pair}'s minimum of ${m.minQty}` };
  }
  if (m.minNotional && price && qty * price < m.minNotional) {
    return { ok: false, message: `Order value is below ${pair}'s minimum order value of ${m.minNotional}` };
  }
  return { ok: true, quantity: qty };
}

export async function placeMarketOrder(cfg, paramsIn) {
  let params = paramsIn;
  const side = params.side === "sell" ? "sell" : "buy";
  // A close can never sell more than the account actually holds: exchanges
  // that charge fees in the base asset (Kraken does) leave less than the
  // recorded buy quantity, and selling the recorded amount is refused with
  // EOrder:Insufficient funds — stranding the position. Cap the sell to the
  // real holding, minus a small buffer so the fee never overshoots again.
  // A margin short OPEN also sells without holdings: it is placed as a Kraken
  // margin order backed by the margin account, not by owned assets, so the
  // hold cap and dust check below (which are about closing a spot position)
  // do not apply to it.
  if (side === "sell" && params.margin !== true) {
    const acct = await readAccount({
      exchange: cfg.exchange,
      testnet: Boolean(cfg.testnet),
      api_key: cfg.api_key,
      api_secret: cfg.api_secret,
      passphrase: cfg.passphrase || "",
    });
    if (!acct.ok) return { ok: false, message: `Could not read the account before closing: ${acct.message}` };
    const asset = String(params.symbol || "").toUpperCase();
    const held = (acct.balances || []).find((b) => b && b.asset === asset);
    const total = held ? Number(held.total) || 0 : 0;
    const capped = total > 0 ? Math.min(Number(params.quantity) || 0, total * 0.995) : 0;
    // dust: the account holds less than the pair's minimum sellable amount and
    // the leftover is worth under a dollar — no exchange order can ever close
    // this position, so the caller books the close on the desk instead of
    // stranding it open behind an order the exchange always refuses
    const pair0 = `${asset}${
      String(params.quote || "").toUpperCase() === "BTC"
        ? (cfg.exchange === "kraken" ? "XBT" : "BTC")
        : (cfg.quoteAsset || QUOTE_ASSET[cfg.exchange] || "USDT")
    }`;
    const cons = total > 0 ? await fetchMarketConstraints(cfg) : null;
    const minQty = cons && cons.get(pair0) ? Number(cons.get(pair0).minQty) || 0 : 0;
    const px =
      total > 0 && minQty > 0 && capped < minQty
        ? (await fetchLivePrices([asset])).get(asset) || 0
        : 0;
    if (total <= 0 || (minQty > 0 && capped < minQty && total * px < 1))
      return {
        ok: false,
        dust: true,
        held_qty: round(total, 8),
        message: `The account holds ${round(total, 8)} ${asset}, below the exchange's minimum sellable amount`,
      };
    params = { ...params, quantity: capped };
  }
  // quoteAsset is the funding asset resolved from the account's balances
  // (USD or USDT on Kraken) — orders settle in the pair's quote currency. A
  // caller may name the quote its own order settles in instead: a Bitcoin
  // market, which Kraken spells XBT.
  const namedQuote = String(params.quote || "").toUpperCase() === "BTC"
    ? (cfg.exchange === "kraken" ? "XBT" : "BTC")
    : "";
  const pair = `${String(params.symbol || "").toUpperCase()}${namedQuote || cfg.quoteAsset || QUOTE_ASSET[cfg.exchange] || "USDT"}`;
  const idem = idemKey(params.symbol);
  if (cfg.exchange === "bybit") return bybitOrder(cfg, params, side, pair, idem);
  // a KuCoin short is a margin order: it sells an asset the account does not
  // own (auto-borrowed) and buys it back with the debt repaid
  if (cfg.exchange === "kucoin")
    return params.margin === true
      ? kucoinMarginOrder(cfg, params, side, pair, idem)
      : kucoinOrder(cfg, params, side, pair, idem);
  if (cfg.exchange === "kraken") return krakenOrder(cfg, params, side, pair, idem);
  return binanceOrder(cfg, params, side, pair, idem);
}

/**
 * Converts a fiat cash balance (CAD, EUR, GBP) into USD by buying on the
 * Kraken USD/fiat market — the only API route to move that cash into the
 * currency the bot's orders settle in. USD (not USDT) is the target because
 * Kraken restricts USDT trading in some Canadian provinces (e.g. CA:SK).
 * Returns {ok, order_id, filled_qty, message}.
 */
export async function convertFiatToUsd(cfg, { amount, currency }) {
  if (cfg.exchange !== "kraken")
    return { ok: false, message: "Fiat conversion is available on Kraken connections only" };
  const cur = String(currency || "CAD").toUpperCase();
  const pairsRes = await callJson("https://api.kraken.com/0/public/AssetPairs");
  const pairRow = Object.values((pairsRes.data || {}).result || {}).find(
    (p) => p && p.wsname === `USD/${cur}`,
  );
  if (!pairRow) return { ok: false, message: `Kraken has no USD/${cur} market` };
  const ticker = await callJson(`https://api.kraken.com/0/public/Ticker?pair=${pairRow.altname}`);
  const info = Object.values((ticker.data || {}).result || {})[0];
  const price = info && Number(info.c && info.c[0]);
  if (!(price > 0)) return { ok: false, message: "Could not read the current USD price" };
  // 1% of the cash stays free so the exchange's fee never exceeds the balance
  const vol = trunc(((Number(amount) || 0) * 0.99) / price, Number(pairRow.lot_decimals) || 8);
  const orderMin = Number(pairRow.ordermin) || 0;
  if (orderMin && vol < orderMin)
    return { ok: false, message: `Convert amount is below the ${orderMin} USDT order minimum` };
  const path = "/0/private/AddOrder";
  const res = await withKrakenSlot(async () => {
    const nonce = String(krakenNonce());
    const body = `nonce=${nonce}&pair=${pairRow.altname}&type=buy&ordertype=market&volume=${vol}`;
    const sign = await krakenSign(cfg.api_secret, path, nonce, body);
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
  const data = res.data || {};
  const failed = Array.isArray(data.error) ? data.error : [];
  const result = data.result || {};
  const txid = Array.isArray(result.txid) ? result.txid[0] : result.txid;
  if (!failed.length && txid)
    return {
      ok: true,
      order_id: String(txid),
      filled_qty: vol,
      message: `Bought ${vol} USD with ${round(amount, 2)} ${cur} at ${round(price, 4)} ${cur}/USD`,
    };
  return {
    ok: false,
    message: `Kraken said: ${KRAKEN_MESSAGES[failed[0] || ""] || failed[0] || res.text || "no response from Kraken"}`,
  };
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
  let stored = null;
  if (config.real_connection_id) {
    // credential fields are hidden from every client-side read, so this read
    // goes through the service role — with an owner check, since the row rules
    // no longer apply here
    stored = await base44.asServiceRole.entities.ExchangeConnection
      .get(config.real_connection_id)
      .catch(() => null);
    // the saved account was deleted (e.g. the key was re-added): fall back to
    // the owner's auto-select instead of leaving the desk dark on a dead id
    if (!stored && config.id && config.created_by_id) config.real_connection_id = "";
  }
  if (!stored && config.id && config.created_by_id) {
    // no account picked yet: with exactly one verified, trading-enabled
    // connection of the owner's, the choice is unambiguous — select it (and
    // remember the pick) instead of leaving the desk dark despite a key that
    // verified fine
    const owned = await base44.asServiceRole.entities.ExchangeConnection
      .filter(
        {
          created_by_id: config.created_by_id,
          allow_trading: true,
          // in a management close the check flag is only a stale snapshot, so
          // the dead-id fallback may pick a connection a check once flagged
          ...(manage ? {} : { status: "connected" }),
        },
        { limit: 2 },
      )
      .catch(() => null);
    if (owned && owned.items && owned.items.length === 1) {
      stored = owned.items[0];
      const rulesPatch = { ...(config.live_rules || {}), real_connection_id: stored.id };
      if (!opts.readOnly) await base44.asServiceRole.entities.BotConfig
        .update(config.id, { real_connection_id: stored.id, live_rules: rulesPatch })
        .catch(() => {});
      config.real_connection_id = stored.id;
      if (config.live_rules) config.live_rules.real_connection_id = stored.id;
    }
  }
  if (!stored) {
    return { conn: null, reason: "No exchange account is selected for real orders", info: null };
  }
  if (config.created_by_id && stored.created_by_id !== config.created_by_id) {
    return { conn: null, reason: "The selected exchange account is missing", info: null };
  }
  const info = {
    id: stored.id,
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
  if (stored.allow_trading !== true) {
    return { conn: null, reason: `${info.label} has trading disabled`, info };
  }
  // management (closing real positions) still works on a connection whose last
  // check failed: the flag is only a stale snapshot, and a close must be able
  // to attempt the real order — the exchange itself is the final gate. New
  // entries are gated separately and still require a verified connection.
  if (stored.status !== "connected" && !manage) {
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

// KuCoin's public sandbox is retired: orders only ever go to the live venue.
// The key's own version must be sent in the header (2 or 3, same signature
// scheme); a 400004 answer means the key is the other version, so the order is
// retried once with it.
async function kucoinPost(cfg, endpoint, payload) {
  const body = JSON.stringify(payload);
  const send = async (version) =>
    callJson("https://api.kucoin.com" + endpoint, {
      method: "POST",
      headers: {
        ...(await kucoinAuthHeaders(cfg, "POST", endpoint, body, version)),
        "Content-Type": "application/json",
      },
      body,
    });
  const first = await send("2");
  if (String(((first.data || {}).code) || "") === "400004") return send("3");
  return first;
}

async function kucoinOrder(cfg, { symbol, usd, quantity }, side, pair, idem) {
  const endpoint = "/api/v1/orders";
  const payload = {
    clientOid: idem,
    side: side.toUpperCase(),
    symbol: `${String(symbol || "").toUpperCase()}-${cfg.quoteAsset || QUOTE_ASSET[cfg.exchange] || "USDT"}`,
    type: "market",
  };
  if (side === "buy") payload.funds = String(round(usd, 2));
  else payload.size = String(trunc(quantity, 8));
  const res = await kucoinPost(cfg, endpoint, payload);
  const data = res.data || {};
  const orderId = ((data.data || {}).orderId) || "";
  if (data.code === "200000" && orderId) {
    return { ok: true, order_id: String(orderId), filled_qty: null, avg_price: null, message: `Market ${side} sent to KuCoin` };
  }
  return { ok: false, message: `KuCoin said: ${data.msg || data.code || res.text || "no response from KuCoin"}` };
}

// ---- KuCoin cross margin (shorting) ----
// KuCoin's spot endpoint can never open a short: the margin endpoint borrows
// the base asset, sells it, and later buys it back to repay. `autoBorrow` on
// the opening sell and `autoRepay` on the closing buy make that one call each,
// so the desk manages a KuCoin short exactly like any other position.
async function kucoinMarginOrder(cfg, { symbol, usd, quantity, price, leverage }, side, pair, idem) {
  const endpoint = "/api/v1/margin/order";
  const asset = String(symbol || "").toUpperCase();
  const quote = cfg.quoteAsset || QUOTE_ASSET[cfg.exchange] || "USDT";
  const guard = await guardConstraints(cfg, { usd, quantity, price, side, pair });
  if (!guard.ok) return { ok: false, message: guard.message };
  const px =
    Number(price) > 0
      ? Number(price)
      : (await fetchLivePrices([asset])).get(asset) || 0;
  const payload = {
    clientOid: idem,
    symbol: `${asset}-${quote}`,
    side: side.toUpperCase(),
    type: "market",
  };
  if (side === "buy") {
    // closing the short: spend the position's quote value and let KuCoin repay
    // the borrowed asset out of the proceeds
    const spend = Number(usd) > 0 ? Number(usd) : (Number(quantity) || 0) * px;
    if (!(spend > 0)) return { ok: false, message: "No usable price to size the margin close" };
    payload.funds = String(round(spend, 2));
    payload.autoRepay = true;
  } else {
    // opening the short: sell the borrowed base quantity
    const qty =
      Number(guard.quantity != null ? guard.quantity : quantity) ||
      (px > 0 && Number(usd) > 0 ? Number(usd) / px : 0);
    if (!(qty > 0)) return { ok: false, message: "No usable price to size the margin order" };
    payload.size = String(trunc(qty, 8));
    payload.autoBorrow = true;
  }
  const res = await kucoinPost(cfg, endpoint, payload);
  const data = res.data || {};
  const orderId = ((data.data || {}).orderId) || "";
  if (data.code === "200000" && orderId) {
    return {
      ok: true,
      order_id: String(orderId),
      filled_qty: side === "sell" ? Number(payload.size) || null : null,
      avg_price: null,
      message: `Margin ${side} sent to KuCoin`,
    };
  }
  // KuCoin refuses pairs that cannot be borrowed, and keys without margin
  // trading permission — its own wording is the clearest thing to show
  return { ok: false, message: `KuCoin margin said: ${data.msg || data.code || res.text || "no response from KuCoin"}` };
}

// ---- Kraken (HMAC-SHA512 over path + sha256(nonce + body)) ----
async function krakenOrder(cfg, { symbol, usd, quantity, price, validate, margin, leverage }, side, pair, idem) {
  const px = Number(price) || 0;
  const guard = await guardConstraints(cfg, { usd, quantity, price, side, pair });
  if (!guard.ok) return { ok: false, message: guard.message };
  const vol = trunc(
    side === "buy"
      ? // a short close buys back the recorded base quantity; a spot buy spends quote
        Number(usd) > 0 ? (px ? usd / px : 0) : Number(quantity) || 0
      : Number(guard.quantity != null ? guard.quantity : quantity) || 0,
    8,
  );
  if (!(vol > 0)) return { ok: false, message: "No usable price to size a market order on Kraken" };
  const path = "/0/private/AddOrder";
  // Kraken's `type` is the direction (buy/sell) and `ordertype` is market —
  // anything else comes back as EGeneral:Invalid arguments:type
  // a margin order carries a leverage level: that is what lets the account
  // sell an asset it holds none of (opening a short)
  const marginLeverage = margin === true && Number(leverage) > 0 ? Number(leverage) : null;
  const res = await withKrakenSlot(async () => {
    const nonce = String(krakenNonce());
    const body = `nonce=${nonce}&pair=${pair}&type=${side}&ordertype=market&volume=${vol}${validate ? "&validate=true" : ""}${marginLeverage ? `&leverage=${marginLeverage}` : ""}`;
    const sign = await krakenSign(cfg.api_secret, path, nonce, body);
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