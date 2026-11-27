// Self-test for the BTC-quoted market leg's sizing, floor and balance rules.
// Run with:
//   deno run --allow-read vps/btcmarkets_selftest.ts
//
// A silent error here sizes a real Bitcoin order wrongly — too small for
// Kraken to fill, or larger than the Bitcoin the account actually holds — and
// the desk would only find out from a refused order.

import { entryMinimum, liveEntrySize } from "../base44/shared/entryRules.ts";
import { keepBalances, pickBtcBalance } from "../base44/shared/exchanges.ts";
import { usdInQuote } from "../base44/shared/quotes.ts";

function assert(ok: boolean, label: string) {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok ${label}`);
}

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- 1. the dollar path is untouched by the new floors and precision
const usdRow = { entry: 100, stop: 97.5 };
assert(
  close(liveEntrySize({ row: usdRow, balance: 1000, budget: 1000, slots: 1, riskPct: 4 }), 995),
  "a dollar order is still capped by the free balance, to the cent",
);
assert(
  close(liveEntrySize({ row: usdRow, balance: 100, budget: 1000, slots: 4, riskPct: 4 }), 24.87),
  "a dollar order is still spread across its free slots",
);
assert(
  liveEntrySize({ row: usdRow, balance: 9.9, budget: 1000, slots: 1, riskPct: 4 }) === 0,
  "an account under $10 still places no dollar order",
);

// ---- 2. the floor is the caller's, in the quote the pair settles in
assert(entryMinimum(new Map(), "SOL", "USD", 100) === 10, "a dollar pair floors at $10 by default");
assert(
  close(entryMinimum(new Map([["SOLUSD", { minQty: 0.5 }]]), "SOL", "USD", 100), 50.5),
  "the exchange's own dollar minimum still wins over the floor",
);
const btcConstraints = new Map([["SOLBTC", { minQty: 1000 }]]);
assert(
  close(entryMinimum(btcConstraints, "SOL", "BTC", 0.0005, 0.00016667), 0.505),
  "a BTC pair floors at the caller's floor and its own volume minimum",
);
assert(
  close(entryMinimum(new Map(), "SOL", "BTC", 0.0005, 0.00016667), 0.00016667),
  "a BTC pair with no constraints floors at the caller's floor, not at ten bitcoin",
);

// ---- 3. a BTC order is sized in bitcoin, not in tenths of a coin
const btcRow = { entry: 0.0005, stop: 0.00049 };
const floorBtc = 0.00016667; // $10 at BTC 60,000
const btcSize = liveEntrySize({
  row: btcRow,
  balance: 0.001,
  budget: 0.001,
  slots: 1,
  riskPct: 4,
  minimum: 0,
  floor: floorBtc,
  decimals: 8,
});
assert(close(btcSize, 0.000995), "a BTC order spends the account's whole Bitcoin, to the satoshi");
assert(btcSize * 60000 > 59 && btcSize * 60000 < 60, "that order is worth about $60, not $60,000");
assert(
  liveEntrySize({ row: btcRow, balance: 0.0001, budget: 0.001, slots: 1, riskPct: 4, floor: floorBtc, decimals: 8 }) === 0,
  "an account holding under $10 of Bitcoin places no order",
);
// the smallest real Bitcoin order is far below a cent: at two decimals the
// same sizing floors to zero and nothing would ever trade
const smallBtc = {
  row: btcRow,
  balance: 0.01,
  budget: 0.01,
  slots: 1,
  riskPct: 4,
  minimum: floorBtc,
  floor: floorBtc,
  decimals: 8,
};
assert(liveEntrySize(smallBtc) > 0, "a small BTC order survives at satoshi precision");
assert(
  liveEntrySize({ ...smallBtc, decimals: 2 }) === 0,
  "and the same order would vanish at two decimals, which is why the leg asks for eight",
);

// ---- 4. the balance is Bitcoin's spot wallet, never the dollar cash
assert(
  close(pickBtcBalance([{ asset: "BTC", total: 0.0012, spot: 0.001 }]), 0.001),
  "the Bitcoin balance is the spot wallet, to the satoshi",
);
assert(
  close(pickBtcBalance([{ asset: "BTC", total: 0.00001234 }]), 0.00001234),
  "a tiny Bitcoin holding keeps its satoshis",
);
assert(pickBtcBalance([{ asset: "USD", total: 500 }]) === 0, "dollars are not Bitcoin");
assert(pickBtcBalance([]) === 0, "an account holding no Bitcoin has none to spend");

// the stored balance list is capped: the Bitcoin row must survive the cap even
// when it is the smallest holding by unit count, or the Bitcoin book reads zero
const many = Array.from({ length: 30 }, (_, i) => ({ asset: `COIN${i}`, total: 1000 - i }));
const capped = keepBalances([...many, { asset: "BTC", total: 0.00004321 }]);
assert(capped.length <= 25, "the stored list stays bounded");
assert(
  close(pickBtcBalance(capped), 0.00004321),
  "a small Bitcoin holding survives the cap at satoshi precision",
);
assert(
  keepBalances([{ asset: "BTC", total: 0 }, { asset: "USD", total: 3 }]).every((b) => b.asset !== "BTC"),
  "a zero Bitcoin row is not kept as a holding",
);

// ---- 5. a dollar rule expressed in the quote: an order floor, a liquidity floor
assert(close(usdInQuote(10, "BTC", 60000), 10 / 60000), "a $10 order floor is a fraction of a bitcoin");
assert(usdInQuote(10, "USD", 60000) === 10, "a dollar floor is itself on a dollar market");
assert(
  close(usdInQuote(5_000_000, "BTC", 60000), 5_000_000 / 60000),
  "the $5m liquidity floor is the same rule in bitcoin",
);
assert(usdInQuote(10, "BTC", 0) === 0, "without a rate the floor is zero, never free");

console.log("all BTC-market self-tests passed");
