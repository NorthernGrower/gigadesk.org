// Self-test for the portfolio risk controls: run with
//   deno run vps/risk_selftest.ts
// Pure functions, synthetic inputs, non-zero exit on the first failed assertion.

import { capPositionSize, drawdownPct, losingStreak, riskState, safetyExit } from "../base44/shared/risk.ts";

function assert(ok: boolean, label: string) {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok ${label}`);
}

const base = {
  starting_balance: 10_000,
  realized_pnl_total: 0,
  realized_pnl_today: 0,
  open_size_usd: 0,
  losing_streak: 0,
};

// a clean desk trades at full size
const clean = riskState(base);
assert(clean.size_multiplier === 1 && !clean.block_entries, "a clean desk trades full size");
assert(clean.reason === null, "a clean desk has no reason");

// drawdown from the peak: 500 lost is a 5% drawdown, which halves size
assert(Math.abs(drawdownPct(10_000, -500) - 5) < 1e-9, "5% drawdown is measured from the peak");
const reduced = riskState({ ...base, realized_pnl_total: -600 });
assert(reduced.size_multiplier === 0.5 && !reduced.block_entries, "a 6% drawdown halves size");
assert((reduced.reason || "").includes("drawdown"), "the drawdown reason is reported");

// a 10% drawdown stops new entries
const stopped = riskState({ ...base, realized_pnl_total: -1000 });
assert(stopped.block_entries && stopped.size_multiplier === 0, "a 10% drawdown blocks entries");

// a daily loss stops entries even with no drawdown
const daily = riskState({ ...base, realized_pnl_today: -350 });
assert(daily.block_entries, "a 3.5% daily loss blocks entries");

// profit is not a reason to stop
const up = riskState({ ...base, realized_pnl_total: 2000, realized_pnl_today: 200 });
assert(!up.block_entries && up.size_multiplier === 1, "a profitable desk is unrestricted");

// losing streaks: 3 halves, 6 stops
const three = riskState({ ...base, losing_streak: 3 });
assert(three.size_multiplier === 0.5 && !three.block_entries, "3 losses halve size");
const six = riskState({ ...base, losing_streak: 6 });
assert(six.block_entries, "6 losses block entries");

// deployment ceiling
const deployed = riskState({ ...base, open_size_usd: 6500 });
assert(deployed.block_entries, "65% deployed blocks new entries");

// the strictest rule wins
const both = riskState({ ...base, realized_pnl_total: -600, losing_streak: 4 });
assert(both.size_multiplier === 0.5, "two reductions do not compound below half");

// position cap: 10% of 10k
assert(capPositionSize(3000, 10_000) === 1000, "a position is capped at 10% of equity");
assert(capPositionSize(400, 10_000) === 400, "a small position is left alone");

// losing streak from closed trades, newest first
assert(losingStreak([{ pnl_usd: -1 }, { pnl_usd: -2 }, { pnl_usd: 5 }]) === 2, "streak counts leading losses");
assert(losingStreak([{ pnl_usd: 5 }]) === 0, "a win ends the streak");
assert(losingStreak([]) === 0, "no trades is no streak");

// a zero balance cannot divide by zero
const empty = riskState({ ...base, starting_balance: 0 });
assert(Number.isFinite(empty.drawdown_pct), "a zero balance does not produce NaN");

// the two exits a live position can never wait on: the scheduled desk guard
// and the bot cycle decide them from this one function
const stopHit = safetyExit({ side: "long", entry: 100, stop: 97.5, price: 97 });
assert(stopHit != null && stopHit.reason === "stop", "a breached stop is a stop");
assert(stopHit!.price === 97.5, "the stop fills at its own level, not the gap's print");
assert(
  safetyExit({ side: "long", entry: 100, stop: 97.5, price: 97.5 })!.reason === "stop",
  "a bar that only touches the stop still closes it",
);
assert(
  safetyExit({ side: "long", entry: 100, stop: 97.5, price: 96, maxLossPct: 3 })!.reason === "stop",
  "a bar past both levels books as the stop, the conservative order",
);
assert(safetyExit({ side: "long", entry: 100, stop: 97.5, price: 98 }) === null, "a trade above its stop is left alone");
assert(
  safetyExit({ side: "long", entry: 100, stop: 80, price: 89, maxLossPct: 10 })!.reason === "max_loss",
  "a wide stop still closes at the loss cap",
);
assert(
  safetyExit({ side: "long", entry: 100, stop: 80, price: 89, maxLossPct: 20 }) === null,
  "and the same trade is held while the cap is wider",
);
const shortUp = safetyExit({ side: "short", entry: 100, stop: 102.5, price: 103 });
assert(shortUp != null && shortUp.reason === "stop" && shortUp.price === 102.5, "a short stops out as the price rises");
assert(
  safetyExit({ side: "short", entry: 100, stop: 102.5, price: 98 }) === null,
  "and a short in profit is left alone",
);
assert(safetyExit({ side: "long", entry: 0, stop: 0, price: 50 }) === null, "an entry of zero decides nothing");

console.log("risk selftest passed");
