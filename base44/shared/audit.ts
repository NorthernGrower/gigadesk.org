// One-time audit backtest harness. Compares three trade-engine iterations over
// one fixed historical window with identical markets, sizing, costs and
// execution rules. Pure comparison tool: reads no entity data, changes nothing.
// All three variants walk the SAME bars and share ONE precomputed signal pass
// per symbol, so the delta between iterations isolates the engine changes.
import { fetchCandles, chunk } from "./market.ts";
import { analyzeCoin } from "./strategy.ts";
import { pickCandidates } from "./scan.ts";

const WARMUP = 300;
const FETCH_LIMIT = 500;
const BARS_PER_DAY = 24;
export const AUDIT_DAYS = 7;
const COST_PCT = 0.3; // 0.2% round-trip spot fees + 0.1% round-trip slippage
const STARTING_BALANCE = 10000;
const RISK_PCT = 4;
const SIZE_CAP_PCT = 25;
const COOLDOWN_BARS = 6;

export const ITERATION_NOTES = {
  baseline:
    "Existing engine, unchanged: score >= 62 plus the daily-target gate, engine-set structural stop and target, 48-bar time exit.",
  a: "Iteration A: baseline plus entry filters - the higher-timeframe trend must not oppose the trade, ADX >= 18 with the DI pair owned, at least two confluence tools agreeing, volume at or above its 20-bar average on the signal bar, no chasing (price within 7% of the 20 average toward the trade side, no 'chasing' Fibonacci phase).",
  b: "Iteration B: everything in A plus exits - risk/reward >= 2 required at entry, stop moved to break-even after +1R, 1.5x-ATR trailing stop after +1.5R, underwater trades cut after 24 bars instead of 48.",
};

function passesBaseline(row) {
  return Boolean(row && row.score >= 62 && row.meets_daily_target);
}

function htfOpposes(row) {
  // the higher timeframe speaks in "up"/"down"; the trade speaks in long/short
  if (!row || !row.htf_trend || row.htf_trend === "unknown" || row.htf_trend === "range") return false;
  return row.side === "long" ? row.htf_trend === "down" : row.htf_trend === "up";
}

function passesA(row) {
  if (!passesBaseline(row)) return false;
  const ind = row.indicators || {};
  if (htfOpposes(row)) return false;
  const adxVal = Number(ind.adx) || 0;
  const diOwned =
    row.side === "long"
      ? (Number(ind.plus_di) || 0) > (Number(ind.minus_di) || 0)
      : (Number(ind.minus_di) || 0) > (Number(ind.plus_di) || 0);
  if (adxVal < 18 || !diOwned) return false;
  if ((row.confluence || 0) < 2) return false;
  if ((Number(ind.vol_ratio) || 0) < 1) return false;
  if (ind.ema20) {
    const stretch = ((row.price - ind.ema20) / ind.ema20) * 100 * (row.side === "long" ? 1 : -1);
    if (stretch > 7) return false;
  }
  if (row.fib_phase === "chasing") return false;
  return true;
}

function passesB(row) {
  if (!passesA(row)) return false;
  if ((Number(row.risk_reward) || 0) < 2) return false;
  return true;
}

const GATE = { baseline: passesBaseline, a: passesA, b: passesB };

function regimeLabel(change) {
  if (change == null) return "unknown";
  if (change > 1) return "risk_on";
  if (change < -1) return "risk_off";
  return "sideways";
}

/** BTC's 24h move at each hourly timestamp - the market-condition proxy. */
function btcRegimeMap(btcCandles) {
  const map = new Map();
  if (!btcCandles) return map;
  for (let i = BARS_PER_DAY; i < btcCandles.length; i++) {
    const back = btcCandles[i - BARS_PER_DAY];
    if (back && back.c) map.set(btcCandles[i].t, ((btcCandles[i].c - back.c) / back.c) * 100);
  }
  return map;
}

/**
 * Precomputes the engine's signal for every bar of the window once, from data
 * up to and including that bar only (no look-ahead). The coin's 24h change and
 * 24h volume are reconstructed from the candles themselves, so no current-day
 * ticker value leaks into historical bars.
 */
function prepSymbol(coin, candles) {
  if (!candles || candles.length < WARMUP + AUDIT_DAYS * BARS_PER_DAY + 2) return null;
  const rowsByJ = new Map();
  const end = Math.min(candles.length - 1, WARMUP + AUDIT_DAYS * BARS_PER_DAY);
  for (let j = WARMUP; j < end; j++) {
    const price = candles[j].c;
    const back = candles[j - BARS_PER_DAY];
    const change24h = back && back.c ? ((price - back.c) / back.c) * 100 : 0;
    let v24 = 0;
    for (let k = Math.max(0, j - 23); k <= j; k++) v24 += candles[k].v || 0;
    const row = analyzeCoin(
      { ...coin, change24h, volume24h: v24 * price },
      candles.slice(0, j + 1),
      { medianChange24h: 0, dailyTargetPct: 2, barsPerDay: BARS_PER_DAY, confluenceV2: true },
    );
    if (row) rowsByJ.set(j, row);
  }
  return { coin, candles, rowsByJ };
}

/** Walks one symbol's window under one variant's entry gate and exit rules. */
function simulate(candles, rowsByJ, variant, btcByTime) {
  const gate = GATE[variant];
  const trades = [];
  let missed = 0;
  let pos = null;
  let cooldownUntil = 0;
  const end = Math.min(candles.length - 1, WARMUP + AUDIT_DAYS * BARS_PER_DAY);
  for (let j = WARMUP; j < end; j++) {
    const bar = candles[j];
    if (pos) {
      const long = pos.side === "long";
      const hitStop = long ? bar.l <= pos.stop : bar.h >= pos.stop;
      const hitTarget = long ? bar.h >= pos.target : bar.l <= pos.target;
      const held = j - pos.j;
      let exitPx = null;
      let reason = null;
      if (hitStop) {
        exitPx = pos.stop;
        reason = "stop";
      } else if (hitTarget) {
        exitPx = pos.target;
        reason = "target";
      } else if (variant === "b") {
        const prevClose = candles[j - 1].c;
        const underwater = long ? prevClose < pos.entry : prevClose > pos.entry;
        if (held >= 24 && underwater) {
          exitPx = bar.o;
          reason = "time";
        } else if (held >= 48) {
          exitPx = bar.c;
          reason = "time";
        }
      } else if (held >= 48) {
        exitPx = bar.c;
        reason = "time";
      }
      if (exitPx != null) {
        const raw = long
          ? ((exitPx - pos.entry) / pos.entry) * 100
          : ((pos.entry - exitPx) / pos.entry) * 100;
        trades.push({
          symbol: pos.symbol,
          side: pos.side,
          entry_time: pos.entryTime,
          exit_time: bar.t,
          raw_pct: Math.round(raw * 100) / 100,
          net_pct: Math.round((raw - COST_PCT) * 100) / 100,
          stop_pct: pos.stopPct,
          hold_bars: held,
          reason,
          regime: regimeLabel(btcByTime.get(pos.entryTime)),
        });
        pos = null;
        cooldownUntil = j + COOLDOWN_BARS;
      } else {
        if (variant === "b") {
          // stop management from completed bars only - never intrabar peeking
          const prevClose = candles[j - 1].c;
          const gainR = long ? (prevClose - pos.entry) / pos.unit : (pos.entry - prevClose) / pos.unit;
          if (gainR >= 1) {
            const be = long ? pos.entry * 1.0005 : pos.entry * 0.9995;
            pos.stop = long ? Math.max(pos.stop, be) : Math.min(pos.stop, be);
          }
          if (gainR >= 1.5) {
            const trail = long ? prevClose - 1.5 * pos.atr : prevClose + 1.5 * pos.atr;
            pos.stop = long ? Math.max(pos.stop, trail) : Math.min(pos.stop, trail);
          }
        }
        const row = rowsByJ.get(j);
        if (gate(row)) missed += 1;
      }
      continue;
    }
    if (j < cooldownUntil) {
      const row = rowsByJ.get(j);
      if (gate(row)) missed += 1;
      continue;
    }
    const row = rowsByJ.get(j);
    if (gate(row)) {
      const unit = Math.abs(bar.c - Number(row.stop));
      if (unit > 0) {
        pos = {
          symbol: row.symbol,
          side: row.side,
          entry: bar.c,
          stop: Number(row.stop),
          target: Number(row.target),
          stopPct: Number(row.stop_pct) || 2,
          atr: Number(row.indicators && row.indicators.atr) || bar.c * 0.02,
          unit,
          j,
          entryTime: bar.t,
        };
      }
    }
  }
  return { trades, missed };
}

/**
 * Portfolio assembly: every trade is sized by the bot's own risk model - 4% of
 * the running equity risked between entry and stop, capped at 25% of equity -
 * with equity evolving as trades close, in exit order.
 */
function sizePortfolio(trades) {
  const ordered = [...trades].sort((x, y) => x.exit_time - y.exit_time);
  const done = [];
  let equity = STARTING_BALANCE;
  let peak = equity;
  let maxDd = 0;
  let maxDdPct = 0;
  let streak = 0;
  let maxStreak = 0;
  for (const t of ordered) {
    const eqAtEntry =
      STARTING_BALANCE + done.reduce((a, d) => (d.exit_time <= t.entry_time ? a + d.pnl_usd : a), 0);
    const size = Math.min(
      (SIZE_CAP_PCT / 100) * eqAtEntry,
      ((RISK_PCT / 100) * eqAtEntry) / Math.max(t.stop_pct / 100, 0.002),
    );
    const pnl = Math.round(((size * t.net_pct) / 100) * 100) / 100;
    equity += pnl;
    done.push({ ...t, size_usd: Math.round(size * 100) / 100, pnl_usd: pnl });
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak ? (dd / peak) * 100 : 0;
    }
    if (pnl < 0) {
      streak += 1;
      maxStreak = Math.max(maxStreak, streak);
    } else streak = 0;
  }
  return {
    done,
    net_usd: equity - STARTING_BALANCE,
    max_dd_usd: maxDd,
    max_dd_pct: maxDdPct,
    max_losing_streak: maxStreak,
  };
}

function metricsFor(rawTrades, missed) {
  const sized = sizePortfolio(rawTrades);
  const trades = sized.done;
  const n = trades.length;
  const winners = trades.filter((t) => t.net_pct > 0);
  const losers = trades.filter((t) => t.net_pct <= 0);
  const grossWin = winners.reduce((a, t) => a + t.pnl_usd, 0);
  const grossLoss = Math.abs(losers.reduce((a, t) => a + t.pnl_usd, 0));
  const netPcts = trades.map((t) => t.net_pct);
  const mean = n ? netPcts.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? netPcts.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const agg = (list) => ({
    trades: list.length,
    win_rate_pct: list.length ? r1((list.filter((t) => t.net_pct > 0).length / list.length) * 100) : 0,
    avg_net_pct: list.length ? r2(list.reduce((a, t) => a + t.net_pct, 0) / list.length) : 0,
  });
  const bucketOf = (t) => (t.hold_bars < 12 ? "under_12h" : t.hold_bars < 24 ? "h_12_to_24" : "over_24h");
  const duration = {};
  for (const key of ["under_12h", "h_12_to_24", "over_24h"])
    duration[key] = agg(trades.filter((t) => bucketOf(t) === key));
  const regimes = {};
  for (const key of ["risk_on", "sideways", "risk_off", "unknown"])
    regimes[key] = agg(trades.filter((t) => (t.regime || "unknown") === key));
  const exits = {};
  for (const t of trades) exits[t.reason] = (exits[t.reason] || 0) + 1;
  return {
    trades: n,
    wins: winners.length,
    win_rate_pct: n ? r1((winners.length / n) * 100) : 0,
    end_equity_usd: r2(STARTING_BALANCE + sized.net_usd),
    net_usd: r2(sized.net_usd),
    return_pct: r2((sized.net_usd / STARTING_BALANCE) * 100),
    profit_factor: grossLoss ? r2(grossWin / grossLoss) : grossWin ? 99 : 0,
    avg_win_usd: winners.length ? r2(grossWin / winners.length) : 0,
    avg_loss_usd: losers.length ? r2(-grossLoss / losers.length) : 0,
    avg_pnl_per_trade_pct: r2(mean),
    per_trade_std_pct: r2(Math.sqrt(variance)),
    max_drawdown_usd: r2(sized.max_dd_usd),
    max_drawdown_pct: r1(sized.max_dd_pct),
    max_losing_streak: sized.max_losing_streak,
    avg_hold_hours: n ? r1(trades.reduce((a, t) => a + t.hold_bars, 0) / n) : 0,
    recovery_factor: sized.max_dd_usd ? r2(sized.net_usd / sized.max_dd_usd) : null,
    duration,
    regimes,
    exits,
    false_signals_stopped_out: exits.stop || 0,
    missed_opportunities: missed,
  };
}

/** Runs the single audit session: one window, three iterations, shared data. */
export async function runAudit(coins, opts = {}) {
  const timeframe = opts.timeframe || "1h";
  const maxSymbols = opts.maxSymbols || 12;
  const universe = pickCandidates(coins, maxSymbols);
  const btcByTime = btcRegimeMap(await fetchCandles("BTC", timeframe, FETCH_LIMIT));

  const tradesBy = { baseline: [], a: [], b: [] };
  const missedBy = { baseline: 0, a: 0, b: 0 };
  const perCoin = {};
  const symbolsUsed = [];

  // fetch phase first: every candidate symbol's candles land before any
  // simulation, so eligibility (data staleness) is decided on the whole
  // universe, identically for every variant
  const fetched = [];
  for (const group of chunk(universe, 6)) {
    const settled = await Promise.allSettled(
      group.map((c) => fetchCandles(c.symbol, timeframe, FETCH_LIMIT)),
    );
    settled.forEach((res, i) => {
      if (res.status === "fulfilled" && res.value) fetched.push({ coin: group[i], candles: res.value });
    });
  }
  // eligible markets: symbols whose candles are current. The ticker feed still
  // lists delisted pairs (UST, SRM, OMG...) whose frozen 24h stats rank them as
  // liquid movers - simulating trades on them would price a market that no
  // longer exists, so every variant skips them alike.
  const lastT = (f) => f.candles[f.candles.length - 1].t;
  const maxLastT = Math.max(...fetched.map(lastT));
  const STALE_MS = 24 * 3600000;
  const eligible = fetched.filter((f) => maxLastT - lastT(f) <= STALE_MS);
  const staleSymbols = fetched.filter((f) => maxLastT - lastT(f) > STALE_MS).map((f) => f.coin.symbol);

  for (const { coin, candles } of eligible) {
    const ready = prepSymbol(coin, candles);
    if (!ready) continue;
    symbolsUsed.push(coin.symbol);
    for (const variant of ["baseline", "a", "b"]) {
      const sim = simulate(candles, ready.rowsByJ, variant, btcByTime);
      tradesBy[variant].push(...sim.trades);
      missedBy[variant] += sim.missed;
      for (const t of sim.trades) {
        const pc = (perCoin[t.symbol] = perCoin[t.symbol] || {
          symbol: t.symbol,
          baseline: { trades: 0, net_pct: 0 },
          a: { trades: 0, net_pct: 0 },
          b: { trades: 0, net_pct: 0 },
        });
        pc[variant].trades += 1;
        pc[variant].net_pct = Math.round((pc[variant].net_pct + t.net_pct) * 100) / 100;
      }
    }
  }

  const iterations = {};
  for (const variant of ["baseline", "a", "b"])
    iterations[variant] = metricsFor(tradesBy[variant], missedBy[variant]);

  return {
    timeframe,
    days: AUDIT_DAYS,
    bars_per_symbol: AUDIT_DAYS * BARS_PER_DAY,
    warmup_bars: WARMUP,
    symbols: symbolsUsed.length,
    symbols_used: symbolsUsed,
    stale_symbols_excluded: staleSymbols,
    universe_note:
      "The scan's own candidate ranking (top-liquid Binance US markets, volume with a mover tilt, BTC included), minus any symbol whose candle data is more than a day stale - the ticker feed still lists delisted pairs whose frozen 24h stats rank them as liquid movers.",
    costs: { fees_round_trip_pct: 0.2, slippage_round_trip_pct: 0.1 },
    sizing: {
      starting_balance: STARTING_BALANCE,
      risk_per_trade_pct: RISK_PCT,
      position_cap_pct: SIZE_CAP_PCT,
      cooldown_bars: COOLDOWN_BARS,
    },
    execution:
      "Signals read only data up to the bar they fire on; fills happen at that bar's close. Stops and targets fill intrabar; when one bar touches both, the stop fills first. Stop management in B uses completed bars only. The market-wide median (relative-strength desk) is neutralised at 0, so no current-day ticker value leaks into history.",
    iterations,
    per_coin: perCoin,
    notes: ITERATION_NOTES,
  };
}