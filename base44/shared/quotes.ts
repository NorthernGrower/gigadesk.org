// Quote currencies a desk can trade. Everything the app measures — the scan,
// the scored engines, the risk rules, the journal — is in USD. A BTC-quoted
// position is measured on its own market, and its USD figures are the pair's
// move at the rate that was used, which is why every conversion lives here
// instead of being scattered through the bot cycle.

export const QUOTES = ["USD", "BTC"];

/** The quote a stored value means, defaulting to USD. */
export function quoteOf(value: any): string {
  return String(value || "").toUpperCase() === "BTC" ? "BTC" : "USD";
}

/** USD value of one unit of the quote at the given BTC rate. 0 when unusable. */
export function fxUsd(quote: any, btcUsd: any): number {
  if (quoteOf(quote) !== "BTC") return 1;
  const rate = Number(btcUsd) || 0;
  return rate > 0 ? rate : 0;
}

/** A USD price expressed in the quote. 0 when the rate is unusable. */
export function toQuote(priceUsd: any, quote: any, btcUsd: any): number {
  const px = Number(priceUsd) || 0;
  if (quoteOf(quote) !== "BTC") return px;
  const fx = fxUsd(quote, btcUsd);
  return fx > 0 ? px / fx : 0;
}

/** A quote price expressed in USD, at the rate supplied. */
export function toUsd(priceQuote: any, quote: any, fx: any): number {
  const px = Number(priceQuote) || 0;
  if (quoteOf(quote) !== "BTC") return px;
  const rate = Number(fx) || 0;
  return rate > 0 ? px * rate : 0;
}

/** The quote code an exchange's pair names use — Kraken calls BTC "XBT". */
export function orderQuote(quote: any, exchange: any): string {
  if (quoteOf(quote) !== "BTC") return "USD";
  return String(exchange || "") === "kraken" ? "XBT" : "BTC";
}

/** The pair an order or a candle read uses, e.g. SOLXBT on Kraken. */
export function pairFor(symbol: any, quote: any, exchange: any): string {
  return `${String(symbol || "").toUpperCase()}${orderQuote(quote, exchange)}`;
}

/**
 * P&L of one position in its own quote, and the same in USD at the rate given.
 * `fx` is the USD value of one quote unit — 1 for USD, BTC's price for BTC.
 */
export function positionPnl(input: any) {
  const { side, entry, exit, quantity, quote, fx } = input || {};
  const e = Number(entry) || 0;
  const x = Number(exit) || 0;
  const q = Number(quantity) || 0;
  const pnlQuote = (String(side) === "short" ? e - x : x - e) * q;
  return { pnl_quote: pnlQuote, pnl_usd: toUsd(pnlQuote, quote, fx) };
}


/**
 * A dollar amount expressed in the quote at the given BTC rate — a $10 order
 * floor, or a $5m liquidity floor, means the same rule on either book. 0 when
 * the rate is unusable, so a floor never silently becomes "anything goes".
 */
export function usdInQuote(usd: any, quote: any, btcUsd: any): number {
  const amount = Number(usd) || 0;
  const fx = fxUsd(quote, btcUsd);
  return fx > 0 ? amount / fx : 0;
}


/**
 * The lesson key a trade is remembered under. A BTC-book trade's result is
 * filed under its own key, so its win rate can never nudge a dollar score, and
 * a dollar result can never nudge a Bitcoin one. USD keeps the two-part key it
 * has always used, so every lesson already stored still resolves.
 */
export function patternFor(side: any, bucket: any, quote: any): string {
  const base = `${String(side || "long")}/${String(bucket || "unknown")}`;
  return quoteOf(quote) === "BTC" ? `${base}/BTC` : base;
}
