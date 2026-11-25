// Self-test for the quote conversions: run with
//   deno run --allow-read vps/quotes_selftest.ts
// These functions decide what a BTC-quoted position is worth in USD, so a
// silent error here would show as a wrong P&L rather than a crash.

import {
  QUOTES,
  fxUsd,
  orderQuote,
  pairFor,
  positionPnl,
  quoteOf,
  toQuote,
  toUsd,
} from "../base44/shared/quotes.ts";

function assert(ok: boolean, label: string) {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok ${label}`);
}

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// 1. the quote defaults to USD, whatever arrives
assert(quoteOf("BTC") === "BTC", "an explicit BTC quote is BTC");
assert(quoteOf("btc") === "BTC", "the quote is case-insensitive");
assert(quoteOf(undefined) === "USD", "a missing quote is USD");
assert(quoteOf("XBT") === "USD", "only the two supported quotes exist");
assert(QUOTES.join(",") === "USD,BTC", "the supported quotes are USD and BTC");

// 2. the USD rate of a quote: 1 for USD, BTC's price for BTC, 0 when unknown
assert(fxUsd("USD", 60000) === 1, "one USD is one USD");
assert(fxUsd("BTC", 60000) === 60000, "one BTC is BTC's USD price");
assert(fxUsd("BTC", 0) === 0, "an unknown BTC rate is unusable");
assert(fxUsd("BTC", null) === 0, "a missing BTC rate is unusable");

// 3. a USD price in the quote, and back again
assert(toQuote(60000, "USD", 60000) === 60000, "a USD price is unchanged in USD");
assert(close(toQuote(60000, "BTC", 60000), 1), "60,000 USD is 1 BTC at 60,000");
assert(close(toQuote(3000, "BTC", 60000), 0.05), "3,000 USD is 0.05 BTC at 60,000");
assert(toQuote(3000, "BTC", 0) === 0, "no rate, no price");
assert(toUsd(0.05, "BTC", 60000) === 3000, "0.05 BTC is 3,000 USD at 60,000");
assert(toUsd(3000, "USD", 60000) === 3000, "a USD price is unchanged coming back");
assert(toUsd(0.05, "BTC", 0) === 0, "no rate, no USD value");

// 4. pair naming: Kraken calls BTC XBT, the other venues do not
assert(orderQuote("USD", "kraken") === "USD", "a USD order keeps its quote code");
assert(orderQuote("BTC", "kraken") === "XBT", "a Kraken BTC order quotes in XBT");
assert(orderQuote("BTC", "binance") === "BTC", "a non-Kraken BTC order quotes in BTC");
assert(pairFor("sol", "USD", "kraken") === "SOLUSD", "a USD pair is built from the symbol");
assert(pairFor("sol", "BTC", "kraken") === "SOLXBT", "a Kraken BTC pair is SOLXBT");

// 5. P&L: in the quote, and in USD at the rate given
const longUsd = positionPnl({ side: "long", entry: 100, exit: 110, quantity: 2, quote: "USD" });
assert(longUsd.pnl_quote === 20 && longUsd.pnl_usd === 20, "a USD long's P&L is the same in both");

const longBtc = positionPnl({ side: "long", entry: 0.05, exit: 0.055, quantity: 2, quote: "BTC", fx: 60000 });
assert(close(longBtc.pnl_quote, 0.01), "the P&L is the pair's own move");
assert(close(longBtc.pnl_usd, 600), "the pair's move is translated at the rate given");

const shortBtc = positionPnl({ side: "short", entry: 0.05, exit: 0.045, quantity: 2, quote: "BTC", fx: 50000 });
assert(close(shortBtc.pnl_quote, 0.01) && close(shortBtc.pnl_usd, 500), "a short gains as the pair falls");

// 6. a pair that went nowhere is worth nothing in USD, whatever BTC did
const flat = positionPnl({ side: "long", entry: 0.05, exit: 0.05, quantity: 2, quote: "BTC", fx: 90000 });
assert(flat.pnl_usd === 0, "no move in the pair, no USD P&L");

// 7. a missing rate never invents a dollar figure
const noRate = positionPnl({ side: "long", entry: 0.05, exit: 0.06, quantity: 1, quote: "BTC", fx: 0 });
assert(noRate.pnl_usd === 0, "an unusable rate reports no USD P&L");

console.log("all quote self-tests passed");
