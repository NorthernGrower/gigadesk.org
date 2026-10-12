// Wallet-position reconciliation. The desk's open real positions are rebuilt
// from what the connected exchange actually holds: every non-cash asset in the
// wallet that the desk is not tracking is imported as a position the bot then
// manages, a position sold off on the exchange is closed on the desk, and a
// partial difference is reconciled. Runs on every bot cycle and on the
// scheduled balance saver, so the desk and the wallet can never drift apart
// for long. Server-side only: this module must never be imported from the
// frontend.
import { asArray, round, fetchLivePrices } from "./market.ts";
import {
  callJson,
  hmacHex,
  hmacB64,
  QUOTE_ALIASES,
  krakenSignedCall,
  krakenAsset,
  KRAKEN_MESSAGES,
} from "./exchanges.ts";

// Cash is not a position: quote currencies, other stables and fiat are the
// wallet's money, never imported as trades.
const CASH_ASSETS = new Set([
  "USD", "USDT", "USDC", "DAI", "TUSD", "BUSD", "FDUSD", "PYUSD", "USDP",
  "FRAX", "GUSD", "USDE", "USDS", "EURC", "EURT", "USD1",
  "CAD", "EUR", "GBP", "JPY", "CHF", "AUD",
]);

const MIN_IMPORT_USD = 1; // a holding worth less than this is dust, not a position
const FULLY_SOLD_USD = 0.5; // below this the wallet is treated as fully out

/**
 * Exchange fill history for average-cost entry pricing. Returns flat rows of
 * {asset, side, qty, price, time(ms)}. Best effort: an unavailable feed
 * returns [] and positions import at the live price instead.
 */
async function fetchFills(cfg, assets) {
  try {
    if (cfg.exchange === "kraken") return await krakenFills(cfg);
    if (cfg.exchange === "binance" || cfg.exchange === "binance_us") return await binanceFills(cfg, assets);
    if (cfg.exchange === "bybit") return await bybitFills(cfg);
    if (cfg.exchange === "kucoin") return await kucoinFills(cfg);
  } catch (err) {
    console.log(`fills for ${cfg.exchange} failed: ${err && err.message}`);
  }
  return [];
}

// Kraken's TradesHistory reports the pair in several shapes across markets
// ("XBTUSD", "CAKEUSD", the AssetPairs key) — normalize through the public
// pair list first, with a suffix-strip fallback.
async function krakenFills(cfg) {
  const pairsRes = await callJson("https://api.kraken.com/0/public/AssetPairs");
  const pairBase = new Map();
  const normQuote = (q) => ({ ZUSD: "USD", USDT: "USDT", USDC: "USDC", ZEUR: "EUR", ZGBP: "GBP", ZCAD: "CAD" }[q] || q);
  for (const p of Object.values((pairsRes.data || {}).result || {})) {
    if (!p) continue;
    const base = krakenAsset(String(p.base || "").toUpperCase());
    const quote = normQuote(String(p.quote || ""));
    for (const key of [p.altname, `${p.base}${p.quote}`, `${base}${quote}`]) {
      if (key) pairBase.set(String(key).toUpperCase(), base);
    }
  }
  const baseOf = (raw) => {
    const s = String(raw || "").toUpperCase();
    if (pairBase.has(s)) return pairBase.get(s);
    const m = s.match(/^(.*?)(USD|USDT|USDC|EUR|GBP|CAD)$/);
    return m ? m[1] : null;
  };
  const fills = [];
  const start = Math.floor((Date.now() - 365 * 86400000) / 1000);
  let ofs = 0;
  for (let page = 0; page < 12; page++) {
    const res = await krakenSignedCall(cfg, "/0/private/TradesHistory", `&start=${start}&ofs=${ofs}`);
    const data = res.data || {};
    const failed = Array.isArray(data.error) ? data.error : [];
    if (failed.length) throw new Error(KRAKEN_MESSAGES[failed[0]] || failed[0]);
    const trades = ((data.result || {}).trades) || {};
    const rows = Object.values(trades);
    for (const t of rows) {
      const asset = baseOf(t.pair);
      if (!asset) continue;
      fills.push({
        asset,
        side: t.type === "buy" ? "buy" : "sell",
        qty: Number(t.vol) || 0,
        price: Number(t.price) || 0,
        time: (Number(t.time) || 0) * 1000,
      });
    }
    if (rows.length < 50) break;
    ofs += 50;
  }
  return fills;
}

async function binanceFills(cfg, assets) {
  const base = cfg.testnet
    ? "https://testnet.binance.vision"
    : cfg.exchange === "binance_us"
      ? "https://api.binance.us"
      : "https://api.binance.com";
  const fills = [];
  for (const asset of assets || []) {
    for (const quote of cfg.exchange === "binance_us" ? ["USDT", "USD"] : ["USDT"]) {
      const qs = `symbol=${asset}${quote}&limit=1000&timestamp=${Date.now()}&recvWindow=10000`;
      const signature = await hmacHex(cfg.api_secret, qs);
      const res = await callJson(`${base}/api/v3/myTrades?${qs}&signature=${signature}`, {
        headers: { "X-MBX-APIKEY": cfg.api_key },
      });
      const rows = Array.isArray(res.data) ? res.data : [];
      for (const t of rows) {
        fills.push({
          asset,
          side: t.isBuyer ? "buy" : "sell",
          qty: Number(t.qty) || 0,
          price: Number(t.price) || 0,
          time: Number(t.time) || 0,
        });
      }
      if (rows.length) break; // found the market it trades on
    }
  }
  return fills;
}

async function bybitFills(cfg) {
  const base = cfg.testnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
  const fills = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const query = `category=spot&limit=100${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`;
    const ts = String(Date.now());
    const sign = await hmacHex(ts + cfg.api_key + "10000" + query, cfg.api_secret);
    const res = await callJson(`${base}/v5/execution/list?${query}`, {
      headers: {
        "X-BAPI-API-KEY": cfg.api_key,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": "10000",
        "X-BAPI-SIGN": sign,
      },
    });
    const result = (res.data || {}).result || {};
    if ((res.data || {}).retCode !== 0) break;
    for (const t of result.list || []) {
      if (t.execType && t.execType !== "Trade") continue;
      const asset = String(t.baseCoin || "").toUpperCase();
      if (!asset) continue;
      fills.push({
        asset,
        side: String(t.side || "").toLowerCase() === "buy" ? "buy" : "sell",
        qty: Number(t.execQty) || Number(t.orderQty) || 0,
        price: Number(t.execPrice) || Number(t.orderPrice) || 0,
        time: Number(t.execTime) || 0,
      });
    }
    cursor = result.nextPageCursor || "";
    if (!cursor) break;
  }
  return fills;
}

async function kucoinFills(cfg) {
  const base = cfg.testnet ? "https://sandbox.kucoin.com" : "https://api.kucoin.com";
  const fills = [];
  const read = async (path, query = "") => {
    const ts = String(Date.now());
    const sign = await hmacB64(cfg.api_secret, ts + "GET" + path + query);
    const res = await callJson(base + path + query, {
      headers: {
        "KC-API-KEY": cfg.api_key,
        "KC-API-SIGN": sign,
        "KC-API-TIMESTAMP": ts,
        "KC-API-PASSPHRASE": await hmacB64(cfg.passphrase || "", cfg.api_secret),
        "KC-API-KEY-VERSION": "2",
      },
    });
    return res.data || {};
  };
  for (const path of ["/api/v1/fills", "/api/v1/hist-orders"]) {
    for (let page = 1; page <= 5; page++) {
      const query = path === "/api/v1/hist-orders" ? `?currentPage=${page}&pageSize=50` : "";
      const data = await read(path, query);
      if (data.code !== "200000") break;
      for (const t of data.data || []) {
        const [asset] = String(t.symbol || "").split("-");
        if (!asset) continue;
        fills.push({
          asset: asset.toUpperCase(),
          side: String(t.side || "").toLowerCase() === "buy" ? "buy" : "sell",
          qty: Number(t.size) || 0,
          price: Number(t.price) || 0,
          time: Number(t.createdAt) || 0,
        });
      }
      if (path === "/api/v1/fills") break;
      if (((data.data || {}).length || 0) < 50) break;
    }
  }
  return fills;
}

/**
 * Syncs the desk's open real positions with the exchange's wallet:
 * - imports every non-cash holding the desk is not tracking (the bot then
 *   manages it like any other position),
 * - closes a desk position the exchange no longer holds (sold off on the
 *   exchange),
 * - reconciles a partial difference (bought or sold extra by hand).
 * `balances` is the account read's {asset, total} list; `opts.ownerId` scopes
 * created records to the desk's owner; `opts.stopPct`/`opts.targetR` place
 * the imported positions' risk levels with the desk's own rules.
 */
export async function syncExchangePositions(base44, conn, balances, opts = {}) {
  const out = { imported: [], closed: [], adjusted: [], reason: null };
  if (!conn || !conn.exchange) {
    out.reason = "No exchange connection";
    return out;
  }
  const ownerId = opts.ownerId;
  if (!ownerId) {
    out.reason = "No desk owner for the sync";
    return out;
  }

  const holdings = (balances || [])
    .map((b) => ({ asset: String(b.asset || "").toUpperCase(), total: Number(b.total) || 0 }))
    .filter((b) => b.asset && !CASH_ASSETS.has(b.asset) && b.total > 0);
  if (!holdings.length) {
    out.reason = "Only cash on the account";
    return out;
  }

  // price every holding so dust is skipped and imports are valued
  const prices = await fetchLivePrices(holdings.map((b) => b.asset));
  const valued = holdings
    .map((b) => ({ ...b, price: prices.get(b.asset) || 0, value: b.total * (prices.get(b.asset) || 0) }))
    .filter((b) => b.price > 0 && b.value >= MIN_IMPORT_USD);
  if (!valued.length) {
    out.reason = "Only dust holdings (nothing priced above dust)";
    return out;
  }

  // average-cost entry from the fill history; a fill feed without the asset
  // (deposited, never traded, or the history is unavailable) imports at the
  // live price instead
  const fills = await fetchFills(conn, valued.map((b) => b.asset));
  const agg = new Map();
  for (const f of fills) {
    const a = String(f.asset || "").toUpperCase();
    if (!a) continue;
    const row = agg.get(a) || { buyVol: 0, buyCost: 0, sellVol: 0, first: null };
    if (f.side === "buy") {
      row.buyVol += f.qty;
      row.buyCost += f.qty * f.price;
    } else {
      row.sellVol += f.qty;
    }
    if (f.time && (row.first == null || f.time < row.first)) row.first = f.time;
    agg.set(a, row);
  }
  const fillsOk = fills.length > 0;

  // the desk's tracked rows: open real positions and pending real proposals,
  // paged to completion (a plain read silently missed rows past the first page)
  const desk = [];
  let cursor;
  do {
    const page = await base44.asServiceRole.entities.Trade.filter(
      { created_by_id: ownerId, mode: "real", status: { $in: ["open", "proposed"] } },
      { sort: "-created_date", limit: 200, ...(cursor ? { cursor } : {}) },
    );
    desk.push(...asArray(page));
    cursor = page && page.next_cursor;
  } while (cursor);

  for (const h of valued) {
    const openRows = desk.filter((t) => String(t.symbol).toUpperCase() === h.asset && t.status === "open");
    const proposedRows = desk.filter((t) => String(t.symbol).toUpperCase() === h.asset && t.status === "proposed");
    const deskQty = openRows.reduce((a, t) => a + (Number(t.quantity) || 0), 0);
    const aggRow = agg.get(h.asset) || null;
    const netVol = aggRow && aggRow.buyVol - aggRow.sellVol > 0 ? aggRow.buyVol - aggRow.sellVol : 0;
    const avgEntry = netVol > 0 && aggRow.buyCost > 0 ? aggRow.buyCost / aggRow.buyVol : null;
    const entry = avgEntry || h.price;
    const qty = h.total;
    const diff = qty - deskQty;

    if (Math.abs(diff) * h.price < MIN_IMPORT_USD) continue; // desk matches the wallet

    if (diff > 0) {
      // untracked holding (or a hand-purchased top-up): import the difference
      if (proposedRows.length) continue; // a pending proposal will become the position
      const openedAt = aggRow && aggRow.first ? new Date(aggRow.first).toISOString() : new Date().toISOString();
      const stopPct = Number(opts.stopPct) > 0 ? Number(opts.stopPct) : 2.5;
      const targetR = Number(opts.targetR) > 0 ? Number(opts.targetR) : 2.5;
      const dist = (entry * stopPct) / 100;
      const created = await base44.entities.Trade.create({
        symbol: h.asset,
        name: h.asset,
        image: "",
        side: "long",
        mode: "real",
        status: "open",
        entry_price: round(entry, 8),
        quantity: round(diff, 8),
        size_usd: round(diff * entry),
        stop_price: round(entry - dist, 8),
        target_price: round(entry + targetR * dist, 8),
        target_r: targetR,
        peak_price: round(entry, 8),
        pattern: "long/imported",
        exchange: conn.exchange,
        rationale: `Imported from the ${conn.label} wallet: the account holds ${round(diff, 8)} ${h.asset} the desk was not tracking. The bot now manages it like any other position.`,
        opened_at: openedAt,
        created_by_id: ownerId,
      });
      out.imported.push({ symbol: h.asset, quantity: round(diff, 8), entry_price: round(entry, 8) });
      await base44.entities.Alert.create({
        symbol: h.asset,
        title: `Imported ${h.asset} from ${conn.label}`,
        message: `The wallet holds ${round(diff, 8)} ${h.asset} ($${round(diff * h.price)}) with no desk position${
          avgEntry ? ` — average fill ${round(entry, 6)} from the exchange's trade history` : ""
        }. Imported at the ${stopPct}% stop and ${targetR}R target and handed to the bot.`,
        mode: "live",
        kind: "bot_open",
        severity: "info",
        trade_id: created.id,
        created_by_id: ownerId,
      });
      continue;
    }

    // diff < 0: the wallet holds less than the desk tracks
    if (qty * h.price < FULLY_SOLD_USD) {
      // everything was sold off on the exchange: close each desk row at the
      // live price
      for (const t of openRows) {
        const e = Number(t.entry_price) || 0;
        const q = Number(t.quantity) || 0;
        const size = Number(t.size_usd) || 0;
        const pnl = (h.price - e) * q;
        await base44.entities.Trade.update(t.id, {
          status: "closed",
          exit_price: round(h.price, 8),
          pnl_usd: round(pnl),
          pnl_pct: size ? round((pnl / size) * 100) : 0,
          closed_at: new Date().toISOString(),
          exit_reason: "manual",
        });
        out.closed.push({ symbol: h.asset, pnl_usd: round(pnl) });
        await base44.entities.Alert.create({
          symbol: h.asset,
          title: `${h.asset} closed (sold on ${conn.label})`,
          message: `The exchange no longer holds ${h.asset}, so the desk position was closed at ${round(h.price, 8)}. P&L ${round(pnl)} USD.`,
          mode: "live",
          kind: "bot_close",
          severity: pnl >= 0 ? "success" : "danger",
          trade_id: t.id,
          created_by_id: ownerId,
        });
      }
      continue;
    }

    // partial difference: shrink the newest row so the desk matches the wallet
    const newest = openRows
      .slice()
      .sort((a, b) => String(b.created_date || "").localeCompare(String(a.created_date || "")))[0];
    if (!newest) continue;
    const newQty = (Number(newest.quantity) || 0) + diff;
    if (newQty <= 0) continue;
    const e = Number(newest.entry_price) || 0;
    await base44.entities.Trade.update(newest.id, {
      quantity: round(newQty, 8),
      size_usd: round(newQty * e),
    });
    out.adjusted.push({ symbol: h.asset, quantity: round(newQty, 8) });
    await base44.entities.Alert.create({
      symbol: h.asset,
      title: `${h.asset} position reconciled with ${conn.label}`,
      message: `The wallet holds ${round(qty, 8)} ${h.asset} while the desk tracked ${round(deskQty, 8)} — the position was adjusted to ${round(newQty, 8)} to match the exchange.`,
      mode: "live",
      kind: "bot_open",
      severity: "warning",
      trade_id: newest.id,
      created_by_id: ownerId,
    });
  }

  if (!out.imported.length && !out.closed.length && !out.adjusted.length) {
    out.reason = fillsOk ? null : "The exchange's trade history was unavailable — holdings were valued at the live price";
  }
  return out;
}