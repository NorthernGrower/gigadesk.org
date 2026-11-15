// V3 direction scanner for a VPS: fetches public Binance klines, runs the
// direction engine on each symbol, writes a snapshot, sleeps, repeats.
//
// Run on any host with Deno (https://deno.com) — no npm install, no keys,
// no orders, read-only public market data:
//
//   deno run --allow-net --allow-read --allow-write vps/direction_scan.ts \
//       --every-minutes 60
//
//   --once              one pass and exit (good for cron instead of a loop)
//   --every-minutes N   rest between passes in loop mode (default 60)
//   --symbols A,B,C     override the watch list (default: USD majors + BTC-quoted)
//
// Output: vps/output/direction_signals.json and .md — the direction,
// conviction, drift band and invalidation level per symbol per timeframe.
// This is a directional read only: it places no orders and holds no keys.

import { directionRead } from "../base44/shared/direction.ts";

const USD_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT",
  "DOTUSDT", "LINKUSDT", "LTCUSDT"];
const BTC_SYMBOLS = ["ETHBTC", "SOLBTC", "XRPBTC", "BNBBTC", "LTCBTC"];
const TIMEFRAMES = ["1d", "4h"];
const KLINES_URL = "https://api.binance.com/api/v3/klines";
const REQUEST_DELAY_MS = 700; // stay well inside the public rate limits

function argValue(flag, fallback) {
  const index = Deno.args.indexOf(flag);
  return index >= 0 && Deno.args[index + 1] ? Deno.args[index + 1] : fallback;
}
const hasFlag = (flag) => Deno.args.includes(flag);

const symbols = hasFlag("--symbols")
  ? argValue("--symbols", "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  : [...USD_SYMBOLS, ...BTC_SYMBOLS];
const everyMinutes = Number(argValue("--every-minutes", "60"));
const once = hasFlag("--once");

async function fetchCandles(symbol, interval, limit = 400) {
  const url = `${KLINES_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`klines ${symbol} ${interval}: HTTP ${response.status}`);
  }
  const rows = await response.json();
  return rows.map((row) => ({
    t: row[0],
    o: parseFloat(row[1]),
    h: parseFloat(row[2]),
    l: parseFloat(row[3]),
    c: parseFloat(row[4]),
    v: parseFloat(row[5]),
  }));
}

async function scanSymbol(symbol) {
  const reads = {};
  let dailyScore = null;
  for (const interval of TIMEFRAMES) {
    const candles = await fetchCandles(symbol, interval);
    const read = directionRead(candles, { timeframe: interval, htfScore: dailyScore });
    if (interval === "1d") dailyScore = read.score;
    reads[interval] = {
      direction: read.direction,
      score: read.score,
      conviction: read.conviction,
      drift_band: read.drift_band,
      invalidation: read.invalidation,
      reasons: read.reasons,
      close: candles[candles.length - 1].c,
      as_of: new Date(candles[candles.length - 1].t).toISOString(),
    };
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }
  return { symbol, reads };
}

function markdown(payload) {
  const lines = [
    "# V3 direction scan",
    "",
    `Generated: ${payload.generated_at} · ${payload.symbols_scanned} symbols · public data, no orders`,
    "",
    "| Symbol | TF | Direction | Conviction | Drift band | Invalidation | As of |",
    "| --- | --- | --- | ---: | --- | --- | --- |",
  ];
  for (const result of payload.results) {
    for (const [timeframe, read] of Object.entries(result.reads)) {
      const band = read.drift_band
        ? `${read.drift_band.low} .. ${read.drift_band.high}`
        : "-";
      const invalidation = read.invalidation
        ? `${read.invalidation.kind} @ ${read.invalidation.level}`
        : "-";
      lines.push(`| ${result.symbol} | ${timeframe} | ${read.direction} | ${read.conviction}% | ${band} | ${invalidation} | ${read.as_of} |`);
    }
  }
  lines.push("", "A fire is a measured probability, not a certainty, and not "
    + "financial advice. The read places no orders and holds no keys.");
  return lines.join("\n");
}

async function pass() {
  const results = [];
  const errors = [];
  for (const symbol of symbols) {
    try {
      results.push(await scanSymbol(symbol));
      console.log(`scanned ${symbol}`);
    } catch (error) {
      errors.push({ symbol, error: String(error) });
      console.error(`error ${symbol}: ${error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
  }
  const payload = {
    generated_at: new Date().toISOString(),
    symbols_scanned: results.length,
    results,
    errors,
  };
  await Deno.mkdir("vps/output", { recursive: true });
  await Deno.writeTextFile("vps/output/direction_signals.json", JSON.stringify(payload, null, 2));
  await Deno.writeTextFile("vps/output/direction_signals.md", markdown(payload));
  console.log(`wrote vps/output/direction_signals.json (${results.length} ok, ${errors.length} errors)`);
}

while (true) {
  await pass();
  if (once) break;
  console.log(`sleeping ${everyMinutes} minutes`);
  await new Promise((resolve) => setTimeout(resolve, everyMinutes * 60_000));
}
