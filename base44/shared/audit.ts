// One-time audit backtest harness. Compares three trade-engine iterations over
// one fixed historical window with identical markets, sizing, costs and
// execution rules. Pure comparison tool: reads no entity data, changes nothing.
// All three variants walk the SAME bars and share ONE precomputed signal pass
// per symbol, so the delta between iterations isolates the engine changes.
import { fetchCandles, fetchCandlesHistory, chunk } from "./market.ts";
import { analyzeCoin } from "./strategy.ts";
import { pickCandidates } from "./scan.ts";
import { KRAKEN_PAIRS, fetchKrakenCandles, fetchKrakenMarginSymbols } from "./kraken.ts";

const WARMUP = 300;
// Bounded indicator lookback for long backtest windows: every series
// analyzeCoin reads needs well under this many bars, and a window keeps a
// six-month signal pass linear in bars instead of quadratic.
const PREP_WINDOW = 600;
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

/** BTC's 24h move at each candle timestamp - the market-condition proxy. */
function btcRegimeMap(btcCandles, barsPerDay = BARS_PER_DAY) {
  const map = new Map();
  if (!btcCandles) return map;
  for (let i = barsPerDay; i < btcCandles.length; i++) {
    const back = btcCandles[i - barsPerDay];
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
function prepSymbol(coin, candles, endBar, barsPerDay = BARS_PER_DAY, step = 1) {
  if (!candles || candles.length < WARMUP + AUDIT_DAYS * barsPerDay + 2) return null;
  const rowsByJ = new Map();
  const end = endBar != null ? endBar : Math.min(candles.length - 1, WARMUP + AUDIT_DAYS * barsPerDay);
  // step > 1 samples the signal pass on every Nth bar: long backtest windows
  // stay inside the function's CPU budget, and every variant walks the SAME
  // sampled pass, so comparisons between variants stay exact
  for (let j = WARMUP; j < end; j += step) {
    const price = candles[j].c;
    const back = candles[j - barsPerDay];
    const change24h = back && back.c ? ((price - back.c) / back.c) * 100 : 0;
    // a rolling day of volume, in the timeframe's own bars
    let v24 = 0;
    for (let k = Math.max(0, j - (barsPerDay - 1)); k <= j; k++) v24 += candles[k].v || 0;
    const row = analyzeCoin(
      { ...coin, change24h, volume24h: v24 * price },
      candles.slice(Math.max(0, j + 1 - PREP_WINDOW), j + 1),
      { medianChange24h: 0, dailyTargetPct: 2, barsPerDay, confluenceV2: true },
    );
    if (row) {
      // pre-move levers, computed straight off the candles so no shared engine
      // code changes: position within the prior 20-bar range (0 = bottom),
      // a fresh 20-bar high/low close on the signal bar, and the candle's
      // conviction (body as a share of its full range)
      const prior = candles.slice(Math.max(0, j - 20), j);
      if (prior.length >= 10) {
        const hi = Math.max(...prior.map((b) => b.h));
        const lo = Math.min(...prior.map((b) => b.l));
        row.range_pos = hi > lo ? (price - lo) / (hi - lo) : 0.5;
        row.breakout_20 = price >= hi || price <= lo;
      }
      const bar = candles[j];
      row.body_ratio = bar.h > bar.l ? Math.abs(bar.c - bar.o) / (bar.h - bar.l) : 0;
      rowsByJ.set(j, row);
    }
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

// ---------------------------------------------------------------------------
// Kraken optimizer: a month of Kraken candles, fetched once per round, with
// many rule variants simulated over the same prepared signals. Kraken taker
// fees are higher than Binance US, so costs stay conservative at 0.5% round
// trip - a variant must survive realistic fees to be called profitable.
// ---------------------------------------------------------------------------

const OPT_COST_PCT = 0.5;
// Kraken spot margin, on top of the round-trip taker fees: a one-time margin
// opening fee when the position opens, and the same-rate rollover fee charged
// every 4 hours while it stays open.
const MARGIN_OPEN_PCT = 0.02;
const MARGIN_ROLLOVER_PCT = 0.02;
const TRAIL_ATR = 1.5;

/**
 * Variant knob set. Defaults are the existing engine rules; each candidate
 * change turns specific knobs on. A variant is a pure config - no engine code
 * changes until a winner is found.
 */
export function variantCfg(id, description, over = {}) {
  return {
    id,
    description,
    min_score: 62,
    require_daily_target: true,
    htf_must_agree: false,
    htf_must_confirm: false,
    min_adx: 0,
    require_di_owned: false,
    min_confluence: 0,
    min_vol_ratio: 0,
    max_stretch_pct: 0,
    no_chasing: false,
    require_fib_pullback: false,
    min_rr: 0,
    min_stop_pct: 0,
    max_stop_pct: 0,
    skip_riskon_long: false,
    skip_sideways_long: false,
    cooldown_bars: 6,
    target_r: null,
    be_stop_r: null,
    trail_r: null,
    time_underwater_bars: 0,
    time_flat_bars: 48,
    long_only: false,
    pattern_must_agree: false,
    pattern_must_support: false,
    pattern_block_q: 0,
    pattern_min_quality: 0,
    skip_weekend: false,
    skip_overnight: false,
    min_stop_atr: 0,
    rsi_chase_block: false,
    div_must_agree: false,
    slope_must_agree: false,
    stoch_must_agree: false,
    max_bb_width: 0,
    entry_limit_pct: 0,
    limit_wait_bars: 8,
    skip_sideways: false,
    max_vol_ratio: 0,
    range_favorable: null,
    require_breakout: false,
    max_bb_width_low: null,
    min_body: 0,
    entry_hours: null,
    margin: false,
    leverage: 1,
    margin_rollover_bars: 4,
    ...over,
  };
}

function gateFor(cfg) {
  return (row) => {
    if (!row || row.score < cfg.min_score) return false;
    if (cfg.long_only && row.side !== "long") return false;
    if (cfg.require_daily_target) {
      if (cfg.target_r != null) {
        const move = cfg.target_r * (Number(row.stop_pct) || 2);
        if (move < 2) return false;
      } else if (!row.meets_daily_target) return false;
    }
    if (cfg.htf_must_agree && htfOpposes(row)) return false;
    if (cfg.htf_must_confirm) {
      const dir = row.side === "long" ? "up" : "down";
      if (!row.htf_trend || row.htf_trend !== dir) return false;
    }
    const ind = row.indicators || {};
    if (cfg.min_adx && (Number(ind.adx) || 0) < cfg.min_adx) return false;
    if (cfg.require_di_owned) {
      const owned =
        row.side === "long"
          ? (Number(ind.plus_di) || 0) > (Number(ind.minus_di) || 0)
          : (Number(ind.minus_di) || 0) > (Number(ind.plus_di) || 0);
      if (!owned) return false;
    }
    if (cfg.min_confluence && (row.confluence || 0) < cfg.min_confluence) return false;
    if (cfg.min_vol_ratio && (Number(ind.vol_ratio) || 0) < cfg.min_vol_ratio) return false;
    if (cfg.max_stretch_pct && ind.ema20) {
      const stretch = ((row.price - ind.ema20) / ind.ema20) * 100 * (row.side === "long" ? 1 : -1);
      if (stretch > cfg.max_stretch_pct) return false;
    }
    if (cfg.no_chasing && row.fib_phase === "chasing") return false;
    if (cfg.require_fib_pullback) {
      // true pullback phases only: shallow, golden, deep
      if (!["shallow", "golden", "deep"].includes(row.fib_phase || "")) return false;
    }
    if (cfg.min_stop_pct && (Number(row.stop_pct) || 0) < cfg.min_stop_pct) return false;
    if (cfg.max_stop_pct && (Number(row.stop_pct) || 0) > cfg.max_stop_pct) return false;
    if (cfg.min_rr && (Number(row.risk_reward) || 0) < cfg.min_rr) return false;
    // lower-timeframe gates, all read off the same precomputed row: chase
    // protection, divergence agreement, trend-slope agreement, stochastic
    // alignment and a calm-volatility ceiling
    if (cfg.rsi_chase_block) {
      const rsiVal = Number(ind.rsi) || 0;
      if (row.side === "long" ? rsiVal > 72 : rsiVal < 28) return false;
    }
    if (cfg.div_must_agree && row.rsi_divergence) {
      const supports = row.side === "long" ? row.rsi_divergence === "bullish" : row.rsi_divergence === "bearish";
      if (!supports) return false;
    }
    if (cfg.slope_must_agree) {
      const slope = Number(ind.ema50_slope) || 0;
      if (row.side === "long" ? slope < 0 : slope > 0) return false;
    }
    if (cfg.stoch_must_agree) {
      const k = Number(ind.stoch_k) || 0;
      const d = Number(ind.stoch_d) || 0;
      if (row.side === "long" ? k < d : k > d) return false;
    }
    if (cfg.max_bb_width && (Number(ind.bb_width_percentile) || 0) > cfg.max_bb_width) return false;
    // chart-pattern gates: the detected swing pattern's bias versus the trade side
    const pBias = row.chart_pattern_bias;
    if (pBias && pBias !== "neutral") {
      const supports = row.side === "long" ? pBias === "bullish" : pBias === "bearish";
      const q = Number(row.chart_pattern_quality) || 0;
      if (cfg.pattern_must_agree && !supports) return false;
      if (cfg.pattern_must_support && !supports) return false;
      if (cfg.pattern_block_q && !supports && q >= cfg.pattern_block_q) return false;
    }
    if (cfg.pattern_min_quality && (Number(row.chart_pattern_quality) || 0) < cfg.pattern_min_quality) return false;
    // pre-move levers, all computed off the raw candles at prep time
    if (cfg.max_vol_ratio && (Number(ind.vol_ratio) || 0) > cfg.max_vol_ratio) return false;
    if (cfg.range_favorable != null) {
      const rp = Number(row.range_pos);
      if (!Number.isFinite(rp)) return false;
      const ok = row.side === "long" ? rp <= cfg.range_favorable : rp >= 1 - cfg.range_favorable;
      if (!ok) return false;
    }
    if (cfg.require_breakout && !row.breakout_20) return false;
    if (cfg.max_bb_width_low != null && (Number(ind.bb_width_percentile) || 100) > cfg.max_bb_width_low)
      return false;
    if (cfg.min_body && (Number(row.body_ratio) || 0) < cfg.min_body) return false;
    return true;
  };
}

function simulateCfg(candles, rowsByJ, cfg, btcByTime) {
  const gate = gateFor(cfg);
  const trades = [];
  let missed = 0;
  let pos = null;
  let pending = null;
  let cooldownUntil = 0;
  const end = candles.length - 1;
  for (let j = WARMUP; j < end; j++) {
    const bar = candles[j];
    // pending limit order: fills when the tape touches the limit price, and
    // cancels if the pullback never comes within the wait window
    if (pending && !pos) {
      if (j > pending.until) {
        missed += 1;
        pending = null;
      } else {
        const filled = pending.long ? bar.l <= pending.limit : bar.h >= pending.limit;
        if (filled) {
          const unitAtFill = Math.abs(pending.limit - pending.stop);
          if (unitAtFill > 0) {
            pos = {
              symbol: pending.row.symbol,
              side: pending.row.side,
              entry: pending.limit,
              stop: pending.stop,
              target:
                cfg.target_r != null
                  ? pending.long
                    ? pending.limit + cfg.target_r * unitAtFill
                    : pending.limit - cfg.target_r * unitAtFill
                  : pending.rowTarget,
              stopPct: (unitAtFill / pending.limit) * 100,
              atr: pending.atr,
              unit: unitAtFill,
              j,
              entryTime: bar.t,
            };
          }
          pending = null;
          if (pos) continue;
        }
      }
    }
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
      } else {
        const prevClose = candles[j - 1].c;
        const underwater = long ? prevClose < pos.entry : prevClose > pos.entry;
        if (cfg.time_underwater_bars && held >= cfg.time_underwater_bars && underwater) {
          exitPx = bar.o;
          reason = "time";
        } else if (cfg.time_flat_bars && held >= cfg.time_flat_bars) {
          exitPx = bar.c;
          reason = "time";
        }
      }
      if (exitPx != null) {
        const raw =
          long ? ((exitPx - pos.entry) / pos.entry) * 100 : ((pos.entry - exitPx) / pos.entry) * 100;
        // margin costs: the round-trip taker fees, Kraken's margin opening
        // fee, and the rollover charged every 4 hours the position is held.
        // Leverage scales the return on capital (and the cost).
        const cost = cfg.margin
          ? OPT_COST_PCT +
            MARGIN_OPEN_PCT +
            (MARGIN_ROLLOVER_PCT * held) / (Number(cfg.margin_rollover_bars) || 4)
          : OPT_COST_PCT;
        trades.push({
          symbol: pos.symbol,
          side: pos.side,
          entry_time: pos.entryTime,
          exit_time: bar.t,
          raw_pct: Math.round(raw * 100) / 100,
          net_pct: Math.round((raw - cost) * (Number(cfg.leverage) || 1) * 100) / 100,
          stop_pct: pos.stopPct,
          hold_bars: held,
          reason,
          regime: regimeLabel(btcByTime.get(pos.entryTime)),
        });
        pos = null;
        cooldownUntil = j + (Number(cfg.cooldown_bars) || COOLDOWN_BARS);
      } else if (cfg.be_stop_r != null || cfg.trail_r != null) {
        const prevClose = candles[j - 1].c;
        const gainR = long ? (prevClose - pos.entry) / pos.unit : (pos.entry - prevClose) / pos.unit;
        if (cfg.be_stop_r != null && gainR >= cfg.be_stop_r) {
          const be = long ? pos.entry * 1.0005 : pos.entry * 0.9995;
          pos.stop = long ? Math.max(pos.stop, be) : Math.min(pos.stop, be);
        }
        if (cfg.trail_r != null && gainR >= cfg.trail_r) {
          const trail = long ? prevClose - TRAIL_ATR * pos.atr : prevClose + TRAIL_ATR * pos.atr;
          pos.stop = long ? Math.max(pos.stop, trail) : Math.min(pos.stop, trail);
        }
        if (gate(rowsByJ.get(j))) missed += 1;
      }
      continue;
    }
    if (j < cooldownUntil) {
      if (gate(rowsByJ.get(j))) missed += 1;
      continue;
    }
    const row = rowsByJ.get(j);
    if (gate(row)) {
      // session gates: thin-tape hours and weekend entries, measured on the bar
      if (cfg.skip_weekend || cfg.skip_overnight) {
        const at = new Date(bar.t);
        if (
          (cfg.skip_weekend && (at.getUTCDay() === 0 || at.getUTCDay() === 6)) ||
          (cfg.skip_overnight && (at.getUTCHours() >= 22 || at.getUTCHours() < 6))
        ) {
          missed += 1;
          continue;
        }
      }
      // a liquid-session gate: only enter inside the stated UTC hour window
      if (cfg.entry_hours) {
        const h = new Date(bar.t).getUTCHours();
        if (h < cfg.entry_hours[0] || h >= cfg.entry_hours[1]) {
          missed += 1;
          continue;
        }
      }
      // a stop tighter than the bar's own noise range gets hit by nothing but noise
      if (cfg.min_stop_atr) {
        const atrVal = Number(row.indicators && row.indicators.atr) || 0;
        if (atrVal > 0 && Math.abs(bar.c - Number(row.stop)) < cfg.min_stop_atr * atrVal) {
          missed += 1;
          continue;
        }
      }
      // regime gates: BTC's 24h tape at entry time. Risk-on longs measured the
      // weakest in every round - a moon-chasing tape is where this engine's
      // entries are least reliable - and sideways longs second weakest.
      if (row.side === "long" && (cfg.skip_riskon_long || cfg.skip_sideways_long)) {
        const regime = regimeLabel(btcByTime.get(bar.t));
        if (
          (cfg.skip_riskon_long && regime === "risk_on") ||
          (cfg.skip_sideways_long && regime === "sideways")
        ) {
          missed += 1;
          continue;
        }
      }
      // a flat BTC tape is where this engine's entries win least, on either
      // side: skip every trade opened into it
      if (cfg.skip_sideways && regimeLabel(btcByTime.get(bar.t)) === "sideways") {
        missed += 1;
        continue;
      }
      const unit = Math.abs(bar.c - Number(row.stop));
      if (unit > 0) {
        const target =
          cfg.target_r != null
            ? row.side === "long"
              ? bar.c + cfg.target_r * unit
              : bar.c - cfg.target_r * unit
            : Number(row.target);
        // limit-entry mode: wait for a better price instead of buying the
        // signal bar's close, so every fill starts closer to the stop
        if (cfg.entry_limit_pct) {
          pending = {
            row,
            long: row.side === "long",
            limit: row.side === "long" ? bar.c * (1 - cfg.entry_limit_pct / 100) : bar.c * (1 + cfg.entry_limit_pct / 100),
            stop: Number(row.stop),
            rowTarget: Number(row.target),
            atr: Number(row.indicators && row.indicators.atr) || bar.c * 0.02,
            until: j + (Number(cfg.limit_wait_bars) || 8),
          };
        } else {
          pos = {
            symbol: row.symbol,
            side: row.side,
            entry: bar.c,
            stop: Number(row.stop),
            target,
            stopPct: (unit / bar.c) * 100,
            atr: Number(row.indicators && row.indicators.atr) || bar.c * 0.02,
            unit,
            j,
            entryTime: bar.t,
          };
        }
      }
    }
  }
  return { trades, missed };
}

/**
 * One optimizer round: fetches a month of Kraken candles once, prepares the
 * engine's signal for every bar, and simulates every variant over it. The
 * signal pass is shared, so the variants differ only by their rules.
 */
export async function runOptimize(coins, variants, opts = {}) {
  const capMap = new Map((coins || []).map((c) => [c.symbol, c]));
  const maxSymbols = opts.maxSymbols || 12;
  // bar geometry: 1h candles give the last 30 tradable days; 4h candles give
  // the same 720-candle fetch as ~70 tradable days — a far bigger sample
  const timeframe = opts.timeframe === "4h" ? "4h" : "1h";
  const barsPerDay = timeframe === "4h" ? 6 : BARS_PER_DAY;
  const interval = timeframe === "4h" ? 240 : 60;
  // deep windows: Kraken's public chart API serves only the last 720 candles,
  // so a window longer than a month pages Binance US kline history instead,
  // over the same liquid pairs, keeping Kraken's conservative fee assumption
  const months = Math.max(1, Number(opts.months) || 1);
  // margin mode: only the pairs Kraken's AssetPairs endpoint lists with sell
  // leverage - the markets a margin account can actually open and short
  const marginSymbols = opts.marginOnly ? await fetchKrakenMarginSymbols() : null;
  const universe = [];
  for (const { pair, symbol } of KRAKEN_PAIRS) {
    const cap = capMap.get(symbol);
    if (!cap) continue;
    if (marginSymbols && !marginSymbols.has(symbol)) continue;
    universe.push({ ...cap, kraken_pair: pair });
    if (universe.length >= maxSymbols) break;
  }
  const btcByTime = btcRegimeMap(
    months > 1
      ? await fetchCandlesHistory("BTC", timeframe, months)
      : await fetchKrakenCandles("XBTUSDT", interval),
    barsPerDay,
  );

  const fetched = [];
  for (const group of chunk(universe, 6)) {
    const settled = await Promise.allSettled(
      group.map((c) =>
        months > 1
          ? fetchCandlesHistory(c.symbol, timeframe, months)
          : fetchKrakenCandles(c.kraken_pair, interval),
      ),
    );
    settled.forEach((res, i) => {
      if (res.status === "fulfilled" && res.value) fetched.push({ coin: group[i], candles: res.value });
    });
  }
  const staleSymbols = [];
  const eligible = fetched.filter((f) => {
    const stale = Date.now() - f.candles[f.candles.length - 1].t > 4 * 3600000;
    if (stale) staleSymbols.push(f.coin.symbol);
    return !stale && f.candles.length >= WARMUP + AUDIT_DAYS * barsPerDay + 2;
  });

  const slots = {};
  const perCoin = {};
  const symbolsUsed = [];
  for (const { coin, candles } of eligible) {
    const ready = prepSymbol(coin, candles, candles.length - 1, barsPerDay, months > 1 ? 2 : 1);
    if (!ready) continue;
    symbolsUsed.push(coin.symbol);
    for (const cfg of variants) {
      const slot = (slots[cfg.id] = slots[cfg.id] || { trades: [], missed: 0 });
      const sim = simulateCfg(candles, ready.rowsByJ, cfg, btcByTime);
      slot.trades.push(...sim.trades);
      slot.missed += sim.missed;
      for (const t of sim.trades) {
        const pc = (perCoin[t.symbol] = perCoin[t.symbol] || {});
        const v = (pc[cfg.id] = pc[cfg.id] || { trades: 0, net_pct: 0, wins: 0 });
        v.trades += 1;
        if (t.net_pct > 0) v.wins += 1;
        v.net_pct = Math.round((v.net_pct + t.net_pct) * 100) / 100;
      }
    }
  }

  const variantsOut = {};
  for (const cfg of variants) {
    const slot = slots[cfg.id] || { trades: [], missed: 0 };
    const { description, ...knobs } = cfg;
    variantsOut[cfg.id] = {
      ...metricsFor(slot.trades, slot.missed),
      description,
      knobs,
    };
  }
  const sampleDays = eligible.length
    ? Math.round(Math.min(...eligible.map((f) => (f.candles.length - WARMUP) / barsPerDay)))
    : 0;
  return {
    timeframe,
    days: sampleDays,
    source: months > 1 ? "binance_us_history" : "kraken",
    months,
    symbols: symbolsUsed.length,
    symbols_used: symbolsUsed,
    stale_symbols_excluded: staleSymbols,
    universe: universe.map((u) => u.symbol),
    costs: {
      round_trip_pct: OPT_COST_PCT,
      margin: !!opts.marginOnly,
      note: opts.marginOnly
        ? "Kraken taker fees (0.5% round trip) plus the margin opening fee (0.02%) and a 0.02% rollover every 4 hours a position is held"
        : "Kraken taker fees plus slippage, charged on every simulated trade",
    },
    sizing: {
      starting_balance: STARTING_BALANCE,
      risk_per_trade_pct: RISK_PCT,
      position_cap_pct: SIZE_CAP_PCT,
      cooldown_bars: COOLDOWN_BARS,
    },
    variants: variantsOut,
    per_coin: perCoin,
  };
}