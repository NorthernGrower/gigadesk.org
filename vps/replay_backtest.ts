// vps/replay_backtest.ts — the direction-ranking replay (V3 Phase A/B).
//
// Ranks every indicator in the wide pool by ONE question: when it claims a
// direction, does price actually close that way N bars later? No profit threshold
// anywhere — an indicator is kept if it predicts direction, and its measured
// hit-rate edge becomes its vote weight. Implements the owner-locked spec in
// Gigadesk-/research/reports/V3_DECISIONS_20261114.md:
//
//   pool:   every indicator in vps/ranking_indicators.ts (state + event votes,
//           plus causal replicas of the direction.ts chassis votes)
//   data:   8 years of Binance public klines per symbol (1d, 4h, 1h), cached to
//           disk so later passes only fetch the new bars
//   splits: per symbol 50% train / 25% validation / 25% OOS, time-ordered,
//           pooled across symbols; OOS is read once and only once per pass
//   keep:   positive hit-rate edge on train AND validation, >=30 train and
//           >=15 validation signals (pooled); primary edge = mean of the
//           N=3/5/10 edges (N=1 reported but excluded as noise)
//   weights: proportional to mean(train, validation) edge, rescaled to sum 100,
//           floor of 0.5pp for small-but-positive edges
//   verdict: the frozen weights are scored once on OOS — never used to select
//   costs:  forward returns reported net of 68 bps round trip (tiebreak only;
//           directional hit-rate itself is cost-free)
//
// Read-only public market data, no keys, no orders. Run with Deno:
//
//   deno run --allow-net --allow-read --allow-write vps/replay_backtest.ts
//   deno run --allow-net --allow-read --allow-write vps/replay_backtest.ts \
//       --every-hours 24     # rerun daily, extending the series each pass
//
// Output: vps/output/indicator_ranking.json + .md (one board per timeframe).

import { INDICATORS } from "./ranking_indicators.ts";

const KLINES_URL = "https://api.binance.com/api/v3/klines";
const REQUEST_DELAY_MS = 700;
const HORIZONS = [1, 3, 5, 10];
const PRIMARY_NS = [3, 5, 10];
const COST = 0.0068; // 68 bps round trip — the research cost model
const INTERVAL_MS: Record<string, number> = { "1h": 3600000, "4h": 14400000, "1d": 86400000 };

function argValue(flag: string, fallback: string): string {
  const i = Deno.args.indexOf(flag);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : fallback;
}
const hasFlag = (f: string) => Deno.args.includes(f);

const symbols = hasFlag("--symbols")
  ? argValue("--symbols", "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  : ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT"];
const timeframes = hasFlag("--timeframes")
  ? argValue("--timeframes", "").split(",").map((s) => s.trim()).filter(Boolean)
  : ["1d", "4h", "1h"];
const startMs = Date.parse(argValue("--start", "2018-12-01T00:00:00Z"));
const everyHours = hasFlag("--every-hours") ? Number(argValue("--every-hours", "24")) : 0;
const minTrainSignals = Number(argValue("--min-train-signals", "30"));
const minValSignals = Number(argValue("--min-val-signals", "15"));

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchKlinePage(symbol: string, interval: string, startTime: number): Promise<any[]> {
  const url = `${KLINES_URL}?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=1000`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 418) { await sleep(60_000 * attempt); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(5_000 * attempt);
    }
  }
  return [];
}

/** Load the disk cache, fetch only the bars it is missing, save it back. */
async function loadCandles(symbol: string, interval: string): Promise<Candle[]> {
  const path = `vps/output/cache/${symbol}_${interval}.json`;
  let candles: Candle[] = [];
  try { candles = JSON.parse(await Deno.readTextFile(path)); } catch { /* first run */ }
  const step = INTERVAL_MS[interval];
  const endMs = Math.floor(Date.now() / step) * step; // closed bars only
  let from = candles.length ? candles[candles.length - 1].t + step : startMs;
  let fetched = 0;
  while (from <= endMs) {
    const rows = await fetchKlinePage(symbol, interval, from);
    if (!rows.length) break;
    for (const row of rows) {
      const t = row[0];
      if (t + step > Date.now()) continue; // drop the in-progress bar
      const c: Candle = { t, o: parseFloat(row[1]), h: parseFloat(row[2]), l: parseFloat(row[3]), c: parseFloat(row[4]), v: parseFloat(row[5]) };
      if (!candles.length || t > candles[candles.length - 1].t) candles.push(c);
    }
    fetched += rows.length;
    from = rows[rows.length - 1][0] + step;
    await sleep(REQUEST_DELAY_MS);
  }
  await Deno.mkdir("vps/output/cache", { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(candles));
  console.log(`  ${symbol} ${interval}: ${candles.length} bars cached (+${fetched} rows fetched)`);
  return candles;
}

// ---- the stats core -----------------------------------------------------------

const SEGMENTS = ["train", "validation", "oos"] as const;
type Segment = (typeof SEGMENTS)[number];
interface Bucket { signals: number; hits: number; retSum: number; upSignals: number; downSignals: number; upHits: number; downHits: number; }
const newBucket = (): Bucket => ({ signals: 0, hits: 0, retSum: 0, upSignals: 0, downSignals: 0, upHits: 0, downHits: 0 });

interface SymbolStats {
  symbol: string; bars: number; first: string; last: string;
  stats: Record<string, Record<Segment, Record<number, Bucket>>>;
  base: Record<Segment, Record<number, { bars: number; up: number }>>;
  perSymbolEdge: Record<string, number>;
}

const segmentOf = (i: number, n: number): Segment => (i < n * 0.5 ? "train" : i < n * 0.75 ? "validation" : "oos");

function analyse(symbol: string, candles: Candle[]): SymbolStats {
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const base: SymbolStats["base"] = { train: {}, validation: {}, oos: {} };
  for (const seg of SEGMENTS) {
    base[seg] = {};
    for (const n2 of HORIZONS) base[seg][n2] = { bars: 0, up: 0 };
  }
  for (let i = 0; i < n; i++) {
    for (const n2 of HORIZONS) {
      if (i + n2 >= n) continue;
      const seg = segmentOf(i, n);
      base[seg][n2].bars++;
      if (closes[i + n2] > closes[i]) base[seg][n2].up++;
    }
  }
  const stats: SymbolStats["stats"] = {};
  for (const ind of INDICATORS) {
    const votes = ind.votes(candles);
    const per: Record<Segment, Record<number, Bucket>> = { train: {}, validation: {}, oos: {} };
    for (const seg of SEGMENTS) {
      per[seg] = {};
      for (const n2 of HORIZONS) per[seg][n2] = newBucket();
    }
    for (let i = 0; i < n; i++) {
      const vote = votes[i];
      if (vote === 0) continue;
      const seg = segmentOf(i, n);
      for (const n2 of HORIZONS) {
        if (i + n2 >= n) continue;
        const raw = closes[i + n2] / closes[i] - 1;
        const up = closes[i + n2] > closes[i];
        const hit = vote > 0 ? up : !up;
        const b = per[seg][n2];
        b.signals++;
        if (hit) b.hits++;
        b.retSum += (vote > 0 ? raw : -raw) - COST;
        if (vote > 0) { b.upSignals++; if (hit) b.upHits++; } else { b.downSignals++; if (hit) b.downHits++; }
      }
    }
    stats[ind.name] = per;
  }
  const perSymbolEdge: Record<string, number> = {};
  for (const ind of INDICATORS) {
    let sum = 0, count = 0;
    for (const seg of ["train", "validation"] as Segment[]) {
      for (const n2 of PRIMARY_NS) {
        const b = stats[ind.name][seg][n2];
        const upFrac = base[seg][n2].bars ? base[seg][n2].up / base[seg][n2].bars : 0.5;
        const baseRate = b.signals ? (upFrac * b.upSignals + (1 - upFrac) * b.downSignals) / b.signals : 0.5;
        sum += (b.signals ? b.hits / b.signals - baseRate : 0) * 100;
        count++;
      }
    }
    perSymbolEdge[ind.name] = count ? sum / count : 0;
  }
  return {
    symbol, bars: n,
    first: new Date(candles[0].t).toISOString().slice(0, 10),
    last: new Date(candles[n - 1].t).toISOString().slice(0, 10),
    stats, base, perSymbolEdge,
  };
}

// ---- the leaderboard ----------------------------------------------------------

interface Row {
  name: string; family: string;
  trainEdge: number; valEdge: number; oosEdge: number;
  trainSignals: number; valSignals: number; oosSignals: number;
  oosNetRet: number;
  perN: Record<string, { train: number; val: number; oos: number }>;
  kept: boolean; weight: number; stability: string;
}

function pooledEdge(results: SymbolStats[], name: string, seg: Segment, n2: number): { edge: number; netRet: number; signals: number } {
  let up = 0, down = 0, upHit = 0, downHit = 0, retSum = 0, signals = 0, baseUp = 0, baseBars = 0;
  for (const r of results) {
    const b = r.stats[name]?.[seg]?.[n2];
    if (!b) continue;
    up += b.upSignals; down += b.downSignals;
    upHit += b.upHits; downHit += b.downHits;
    retSum += b.retSum; signals += b.signals;
    baseUp += r.base[seg][n2].up; baseBars += r.base[seg][n2].bars;
  }
  if (!signals || !baseBars) return { edge: 0, netRet: 0, signals };
  const upFrac = baseUp / baseBars;
  const baseRate = (upFrac * up + (1 - upFrac) * down) / signals;
  const hitRate = (upHit + downHit) / signals;
  return { edge: (hitRate - baseRate) * 100, netRet: retSum / signals, signals };
}

function buildBoard(results: SymbolStats[]): Row[] {
  const rows: Row[] = [];
  for (const ind of INDICATORS) {
    const perN: Row["perN"] = {};
    for (const n2 of HORIZONS) {
      perN[String(n2)] = {
        train: pooledEdge(results, ind.name, "train", n2).edge,
        val: pooledEdge(results, ind.name, "validation", n2).edge,
        oos: pooledEdge(results, ind.name, "oos", n2).edge,
      };
    }
    const primary = (seg: Segment) => PRIMARY_NS.reduce((a, n2) => a + pooledEdge(results, ind.name, seg, n2).edge, 0) / PRIMARY_NS.length;
    const trainEdge = primary("train"), valEdge = primary("validation"), oosEdge = primary("oos");
    const trainSignals = pooledEdge(results, ind.name, "train", 10).signals;
    const valSignals = pooledEdge(results, ind.name, "validation", 10).signals;
    const oosSignals = pooledEdge(results, ind.name, "oos", 10).signals;
    const oosNetRet = PRIMARY_NS.reduce((a, n2) => a + pooledEdge(results, ind.name, "oos", n2).netRet, 0) / PRIMARY_NS.length;
    const posSymbols = results.filter((r) => r.perSymbolEdge[ind.name] >= 0).length;
    const kept = trainEdge > 0 && valEdge > 0 && trainSignals >= minTrainSignals && valSignals >= minValSignals;
    const stability = posSymbols === results.length ? "uniform"
      : posSymbols <= results.length - 3 ? `carried (${posSymbols}/${results.length} positive)`
      : `mixed (${posSymbols}/${results.length} positive)`;
    rows.push({
      name: ind.name, family: ind.family,
      trainEdge, valEdge, oosEdge, trainSignals, valSignals, oosSignals, oosNetRet, perN,
      kept, weight: 0, stability,
    });
  }
  const keptRows = rows.filter((r) => r.kept);
  const raw = keptRows.map((r) => Math.max((r.trainEdge + r.valEdge) / 2, 0.5));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  keptRows.forEach((r, i) => { r.weight = Math.round((raw[i] / sum) * 1000) / 10; });
  rows.sort((a, b) => Number(b.kept) - Number(a.kept) || (b.trainEdge + b.valEdge) - (a.trainEdge + a.valEdge));
  return rows;
}

function markdown(boards: Record<string, Row[]>, inventory: SymbolStats[], generatedAt: string): string {
  const lines: string[] = [
    "# V3 direction-ranking leaderboard",
    "",
    `Generated: ${generatedAt} · pool: ${INDICATORS.length} indicators · data: Binance public klines, no keys, no orders`,
    "",
    "The scoreboard is directional hit-rate edge vs base rate (percentage points) at N bars",
    "forward — no profit threshold. Kept = positive edge on train AND validation with enough",
    "signals. Weight = mean(train, validation) edge, rescaled to 100 across the kept set.",
    "OOS columns are the single frozen verdict read; they are never used for selection.",
    "The `chassis:*` rows are direction.ts's own votes, ranked by the same ruler.",
    "",
  ];
  for (const interval of timeframes) {
    const rows = boards[interval];
    const kept = rows.filter((r) => r.kept);
    lines.push(`## ${interval}`, "");
    lines.push(`Symbols: ${inventory.map((r) => `${r.symbol} ${r.first}→${r.last} (${r.bars} bars)`).join(", ")}`, "");
    lines.push(`Kept ${kept.length} of ${rows.length} indicators.`, "");
    if (kept.length) {
      lines.push(
        "| Rank | Indicator | Family | Weight | Train edge | Val edge | OOS edge | OOS net ret | Train n | Val n | Stability |",
        "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
      );
      kept.forEach((r, i) => {
        lines.push(`| ${i + 1} | ${r.name} | ${r.family} | ${r.weight} | ${r.trainEdge.toFixed(2)} | ${r.valEdge.toFixed(2)} | ${r.oosEdge.toFixed(2)} | ${(r.oosNetRet * 100).toFixed(2)}% | ${r.trainSignals} | ${r.valSignals} | ${r.stability} |`);
      });
      lines.push("");
    } else {
      lines.push("Nothing kept this pass — no indicator held a positive edge on both windows.", "");
    }
    const dropped = rows.filter((r) => !r.kept && r.trainEdge > 0).slice(0, 10);
    if (dropped.length) {
      lines.push("Dropped but train-positive (failed validation — the Run 5 trap):", "");
      lines.push("| Indicator | Train edge | Val edge | Val n |", "| --- | ---: | ---: | ---: |");
      for (const r of dropped) lines.push(`| ${r.name} | ${r.trainEdge.toFixed(2)} | ${r.valEdge.toFixed(2)} | ${r.valSignals} |`);
      lines.push("");
    }
    const chassis = rows.filter((r) => r.family === "chassis");
    if (chassis.length) {
      lines.push("Chassis inverse table (direction.ts's own votes):", "");
      lines.push("| Vote | Train edge | Val edge | OOS edge | Kept | Weight |", "| --- | ---: | ---: | ---: | --- | ---: |");
      for (const r of chassis) lines.push(`| ${r.name} | ${r.trainEdge.toFixed(2)} | ${r.valEdge.toFixed(2)} | ${r.oosEdge.toFixed(2)} | ${r.kept ? "yes" : "no"} | ${r.weight} |`);
      lines.push("");
    }
  }
  lines.push("", "A hit-rate edge is a measured probability, not a certainty, and not financial advice.",
    "This harness places no orders and holds no keys.");
  return lines.join("\n");
}

// ---- one pass -----------------------------------------------------------------

async function pass() {
  const started = Date.now();
  console.log(`=== ranking pass ${new Date().toISOString()} ===`);
  const boards: Record<string, Row[]> = {};
  const inventory: SymbolStats[] = [];
  for (const interval of timeframes) {
    const results: SymbolStats[] = [];
    for (const symbol of symbols) {
      try {
        const candles = await loadCandles(symbol, interval);
        if (candles.length < 400) { console.error(`  ${symbol} ${interval}: only ${candles.length} bars — skipped`); continue; }
        const stats = analyse(symbol, candles);
        results.push(stats);
        if (interval === timeframes[0]) inventory.push(stats);
      } catch (err) {
        console.error(`error ${symbol} ${interval}: ${err}`);
      }
    }
    boards[interval] = buildBoard(results);
  }
  const generatedAt = new Date().toISOString();
  await Deno.mkdir("vps/output", { recursive: true });
  await Deno.writeTextFile("vps/output/indicator_ranking.json", JSON.stringify({
    generated_at: generatedAt,
    config: { symbols, timeframes, start: new Date(startMs).toISOString(), horizons: HORIZONS, primary_ns: PRIMARY_NS, cost: COST, min_train_signals: minTrainSignals, min_val_signals: minValSignals },
    symbols: inventory.map((r) => ({ symbol: r.symbol, bars: r.bars, first: r.first, last: r.last })),
    boards,
  }, null, 2));
  await Deno.writeTextFile("vps/output/indicator_ranking.md", markdown(boards, inventory, generatedAt));
  console.log(`wrote vps/output/indicator_ranking.json + .md in ${Math.round((Date.now() - started) / 1000)}s`);
}

while (true) {
  await pass();
  if (!everyHours) break;
  console.log(`sleeping ${everyHours} hours`);
  await sleep(everyHours * 3600_000);
}
