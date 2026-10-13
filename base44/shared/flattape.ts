// Flat-tape lab: a pure research harness for the question "can the desk make
// money while BTC's 24h tape is flat?" Reads only public candle history,
// writes nothing, changes nothing in the live engine. The simulation rules
// mirror the optimizer's (audit.ts) so results compare apples to apples:
// same warmup, same cost model, same stop/target/time exit mechanics, and
// every variant walks the SAME precomputed signal pass per symbol.
import { fetchMarkets, fetchCandlesHistory, chunk, round } from "./market.ts";
import { analyzeCoin } from "./strategy.ts";

const WARMUP = 300;
const PREP_WINDOW = 600;
const BARS_PER_DAY = 24;
// Kraken-fee-conservative cost model, same as the optimizer's non-margin runs
const COST_PCT = 0.5;
const STARTING_BALANCE = 10000;
const RISK_PCT = 4;
const SIZE_CAP_PCT = 25;

export function regimeLabel(change) {
  if (change == null) return "unknown";
  if (change > 1) return "risk_on";
  if (change < -1) return "risk_off";
  return "sideways";
}

/** BTC's 24h move at each candle timestamp. */
function btcRegimeMap(btcCandles, barsPerDay = BARS_PER_DAY) {
  const map = new Map();
  if (!btcCandles) return map;
  for (let i = barsPerDay; i < btcCandles.length; i++) {
    const back = btcCandles[i - barsPerDay];
    if (back && back.c) map.set(btcCandles[i].t, ((btcCandles[i].c - back.c) / back.c) * 100);
  }
  return map;
}

/** BTC's most recent 1h bar move at each timestamp - the short-lead signal. */
function btcLeadMap(btcCandles) {
  const map = new Map();
  if (!btcCandles) return map;
  for (let i = 1; i < btcCandles.length; i++) {
    const back = btcCandles[i - 1];
    if (back && back.c) map.set(btcCandles[i].t, ((btcCandles[i].c - back.c) / back.c) * 100);
  }
  return map;
}

/**
 * Precomputes the engine's signal for every sampled bar of the window, from
 * data up to and including that bar only (no look-ahead).
 */
function prepSymbol(coin, candles, barsPerDay, step) {
  const rowsByJ = new Map();
  const end = candles.length - 1;
  for (let j = WARMUP; j < end; j += step) {
    const price = candles[j].c;
    const back = candles[j - barsPerDay];
    const change24h = back && back.c ? ((price - back.c) / back.c) * 100 : 0;
    let v24 = 0;
    for (let k = Math.max(0, j - (barsPerDay - 1)); k <= j; k++) v24 += candles[k].v || 0;
    const row = analyzeCoin(
      { ...coin, change24h, volume24h: v24 * price },
      candles.slice(Math.max(0, j + 1 - PREP_WINDOW), j + 1),
      { medianChange24h: 0, dailyTargetPct: 2, barsPerDay, confluenceV2: true },
    );
    if (row) {
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
  return rowsByJ;
}

/**
 * Variant knob set for the flat-tape experiments. Each candidate is a pure
 * config over the shared prepared signals - no engine code changes until a
 * winner is found.
 */
export function flatCfg(id, description, over = {}) {
  return {
    id,
    description,
    min_score: 62,
    regime_in: null, // ["sideways"] restricts entries to the flat tape
    btc_lead_pct: null, // long only after BTC's last 1h bar rose this much (short: fell)
    min_adx: 0,
    require_di_owned: false,
    min_confluence: 0,
    min_vol_ratio: 0,
    max_vol_ratio: 0,
    max_stretch_pct: 0,
    stoch_must_agree: false,
    rsi_chase_block: false,
    min_body: 0,
    range_favorable: null,
    target_r: 2,
    be_stop_r: null,
    time_underwater_bars: 0,
    time_flat_bars: 48,
    cooldown_bars: 6,
    long_only: false,
    short_only: false,
    require_breakout: false,
    max_bb_width: 0,
    max_bb_width_low: null,
    entry_hours: null,
    min_stop_atr: 0,
    regime_before_in: null,
    regime_lag_bars: 24,
    regime_matches_side: false,
    slope_must_agree: false,
    htf_must_agree: false,
    btc_trend_bars: 0,
    min_flat_run: 0,
    ...over,
  };
}

/** BTC's consecutive-sideways run length (in bars) at each timestamp. */
function btcRunMap(btcCandles) {
  const map = new Map();
  if (!btcCandles) return map;
  let run = 0;
  for (let i = 0; i < btcCandles.length; i++) {
    const back = btcCandles[Math.max(0, i - BARS_PER_DAY)];
    const change = back && back.c ? ((btcCandles[i].c - back.c) / back.c) * 100 : null;
    run = change != null && change >= -1 && change <= 1 ? run + 1 : 0;
    map.set(btcCandles[i].t, run);
  }
  return map;
}

function flatGate(cfg, row, btcByTime, btcLeadByTime, barTime, btcSmaMaps, btcRunByTime) {
  if (!row || (Number(row.score) || 0) < cfg.min_score) return false;
  if (cfg.regime_in && !cfg.regime_in.includes(regimeLabel(btcByTime.get(barTime)))) return false;
  if (cfg.long_only && row.side !== "long") return false;
  if (cfg.short_only && row.side !== "short") return false;
  // longer-trend filters: the EMA50 slope must agree with the side, the
  // higher timeframe must not oppose it, and BTC must trade above (longs) or
  // below (shorts) its own N-bar average
  if (cfg.slope_must_agree) {
    const slope = Number(row.indicators && row.indicators.ema50_slope) || 0;
    if (row.side === "long" ? slope < 0 : slope > 0) return false;
  }
  if (cfg.htf_must_agree && row.htf_trend && !["range", "unknown"].includes(row.htf_trend)) {
    const supports = row.side === "long" ? row.htf_trend === "up" : row.htf_trend === "down";
    if (!supports) return false;
  }
  if (cfg.btc_trend_bars) {
    const m = btcSmaMaps && btcSmaMaps.get(Number(cfg.btc_trend_bars));
    const s = m && m.get(barTime);
    if (s) {
      const ok = row.side === "long" ? s.close >= s.sma : s.close <= s.sma;
      if (!ok) return false;
    }
  }
  // compression duration: BTC must have been flat for at least this many
  // consecutive bars before the entry (the longer the coil, the bigger the pop)
  if (cfg.min_flat_run) {
    const run = (btcRunByTime && btcRunByTime.get(barTime)) || 0;
    if (run < cfg.min_flat_run) return false;
  }
  // expansion logic: what BTC's regime was LAG bars ago (the flat tape is the
  // setup), and a require that BTC's regime NOW agrees with the trade side
  if (cfg.regime_before_in) {
    const past = btcByTime.get(barTime - (Number(cfg.regime_lag_bars) || 24) * 3600000);
    if (!cfg.regime_before_in.includes(regimeLabel(past))) return false;
  }
  if (cfg.regime_matches_side) {
    const now = regimeLabel(btcByTime.get(barTime));
    if (now !== (row.side === "long" ? "risk_on" : "risk_off")) return false;
  }
  if (cfg.btc_lead_pct != null) {
    const lead = btcLeadByTime.get(barTime);
    if (row.side === "long" ? !(lead >= cfg.btc_lead_pct) : !(lead <= -cfg.btc_lead_pct)) return false;
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
  if (cfg.min_confluence && (Number(row.confluence) || 0) < cfg.min_confluence) return false;
  if (cfg.min_vol_ratio && (Number(ind.vol_ratio) || 0) < cfg.min_vol_ratio) return false;
  if (cfg.max_vol_ratio && (Number(ind.vol_ratio) || 0) > cfg.max_vol_ratio) return false;
  if (cfg.max_stretch_pct && Number(ind.ema20) > 0) {
    const stretch = ((Number(row.price) - Number(ind.ema20)) / Number(ind.ema20)) * 100 * (row.side === "long" ? 1 : -1);
    if (stretch > cfg.max_stretch_pct) return false;
  }
  if (cfg.stoch_must_agree) {
    const k = Number(ind.stoch_k) || 0;
    const d = Number(ind.stoch_d) || 0;
    if (row.side === "long" ? k < d : k > d) return false;
  }
  if (cfg.rsi_chase_block) {
    const rsiVal = Number(ind.rsi) || 0;
    if (row.side === "long" ? rsiVal > 72 : rsiVal < 28) return false;
  }
  if (cfg.min_body && (Number(row.body_ratio) || 0) < cfg.min_body) return false;
  if (cfg.range_favorable != null) {
    const rp = Number(row.range_pos);
    if (!Number.isFinite(rp)) return false;
    const ok = row.side === "long" ? rp <= cfg.range_favorable : rp >= 1 - cfg.range_favorable;
    if (!ok) return false;
  }
  if (cfg.require_breakout && !row.breakout_20) return false;
  if (cfg.max_bb_width && (Number(ind.bb_width_percentile) || 0) > cfg.max_bb_width) return false;
  if (cfg.max_bb_width_low != null && (Number(ind.bb_width_percentile) || 100) > cfg.max_bb_width_low)
    return false;
  // basic level sanity: levels must face the trade's own direction
  const stop = Number(row.stop);
  const unit = Math.abs(Number(row.price) - stop);
  if (!(unit > 0)) return false;
  return true;
}

/** A liquid-session gate: only enter inside the stated UTC hour window. */
function sessionOk(cfg, barTime) {
  if (!cfg.entry_hours) return true;
  const h = new Date(barTime).getUTCHours();
  return h >= cfg.entry_hours[0] && h < cfg.entry_hours[1];
}

/** A stop tighter than the bar's own noise range gets hit by nothing but noise. */
function stopOk(cfg, row, bar) {
  if (!cfg.min_stop_atr) return true;
  const atrVal = Number(row && row.indicators && row.indicators.atr) || 0;
  return !(atrVal > 0 && Math.abs(bar.c - Number(row.stop)) < cfg.min_stop_atr * atrVal);
}

/** BTC's N-bar simple average and its close at each timestamp. */
function btcSmaMap(btcCandles, bars) {
  const map = new Map();
  if (!btcCandles || !bars) return map;
  let sum = 0;
  for (let i = 0; i < btcCandles.length; i++) {
    sum += btcCandles[i].c;
    if (i >= bars) sum -= btcCandles[i - bars].c;
    if (i >= bars - 1) map.set(btcCandles[i].t, { sma: sum / bars, close: btcCandles[i].c });
  }
  return map;
}

function simulate(candles, rowsByJ, cfg, btcByTime, btcLeadByTime, btcSmaMaps, btcRunByTime) {
  const trades = [];
  let pos = null;
  let cooldownUntil = 0;
  const end = candles.length - 1;
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
        const raw = long
          ? ((exitPx - pos.entry) / pos.entry) * 100
          : ((pos.entry - exitPx) / pos.entry) * 100;
        trades.push({
          symbol: pos.symbol,
          side: pos.side,
          entry_time: pos.entryTime,
          exit_time: bar.t,
          raw_pct: round(raw, 2),
          net_pct: round(raw - COST_PCT, 2),
          stop_pct: round(pos.stopPct, 2),
          hold_bars: held,
          reason,
          regime: regimeLabel(btcByTime.get(pos.entryTime)),
        });
        pos = null;
        cooldownUntil = j + (Number(cfg.cooldown_bars) || 6);
      } else {
        // stop management from completed bars only - never intrabar peeking
        const prevClose = candles[j - 1].c;
        const gainR = long ? (prevClose - pos.entry) / pos.unit : (pos.entry - prevClose) / pos.unit;
        if (cfg.be_stop_r != null && gainR >= cfg.be_stop_r) {
          const be = long ? pos.entry * 1.0005 : pos.entry * 0.9995;
          pos.stop = long ? Math.max(pos.stop, be) : Math.min(pos.stop, be);
        }
      }
      continue;
    }
    if (j < cooldownUntil) continue;
    const row = rowsByJ.get(j);
    if (flatGate(cfg, row, btcByTime, btcLeadByTime, bar.t, btcSmaMaps, btcRunByTime) && sessionOk(cfg, bar.t) && stopOk(cfg, row, bar)) {
      const unit = Math.abs(Number(row.price) - Number(row.stop));
      const target =
        row.side === "long"
          ? bar.c + cfg.target_r * unit
          : bar.c - cfg.target_r * unit;
      pos = {
        symbol: row.symbol,
        side: row.side,
        entry: bar.c,
        stop: Number(row.stop),
        target,
        stopPct: (unit / bar.c) * 100,
        unit,
        j,
        entryTime: bar.t,
      };
    }
  }
  return trades;
}

/** $10k account metrics: 4% risk per trade to its stop, 25% size cap, compounding. */
function metricsFor(trades) {
  const ordered = trades.slice().sort((a, b) => a.exit_time - b.exit_time);
  let balance = STARTING_BALANCE;
  let peak = balance;
  let maxDd = 0;
  let streak = 0;
  let worstStreak = 0;
  for (const t of ordered) {
    const sizePct = Math.min(SIZE_CAP_PCT, (RISK_PCT / Math.max(t.stop_pct, 0.3)) * 100);
    balance += (balance * sizePct * t.net_pct) / 100 / 100;
    peak = Math.max(peak, balance);
    maxDd = Math.max(maxDd, peak - balance);
    if (t.net_pct > 0) streak = 0;
    else {
      streak += 1;
      worstStreak = Math.max(worstStreak, streak);
    }
  }
  const wins = ordered.filter((t) => t.net_pct > 0);
  const losses = ordered.filter((t) => t.net_pct <= 0);
  const grossWin = wins.reduce((a, t) => a + t.net_pct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.net_pct, 0));
  const byRegime = {};
  const byExit = {};
  for (const t of ordered) {
    byRegime[t.regime] = (byRegime[t.regime] || 0) + 1;
    byExit[t.reason] = (byExit[t.reason] || 0) + 1;
  }
  return {
    trades: ordered.length,
    win_rate: ordered.length ? round((wins.length / ordered.length) * 100, 1) : 0,
    avg_net_pct: ordered.length ? round(ordered.reduce((a, t) => a + t.net_pct, 0) / ordered.length, 3) : 0,
    profit_factor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null,
    starting_balance: STARTING_BALANCE,
    final_balance: round(balance, 2),
    pnl_usd: round(balance - STARTING_BALANCE, 2),
    pnl_pct: round(((balance - STARTING_BALANCE) / STARTING_BALANCE) * 100, 2),
    max_drawdown_usd: round(maxDd, 2),
    worst_losing_streak: worstStreak,
    exits: byExit,
    regimes_traded: byRegime,
  };
}

/**
 * One lab run: six months of 1h candles across the most liquid symbols,
 * signals prepared once, every variant simulated over the same pass.
 */
export async function runFlatLab(opts = {}) {
  const months = Math.max(1, Math.min(14, Number(opts.months) || 6));
  // end_offset_months pushes the window BACK in time: 0 = the most recent
  // `months`, 6 = the 6 months before that (disjoint validation windows)
  const endOffset = Math.max(0, Math.min(12, Number(opts.end_offset_months) || 0));
  const fetchMonths = months + endOffset;
  const cutoff = endOffset ? Date.now() - endOffset * 30 * 24 * 3600 * 1000 : 0;
  const sliceCandles = (c) => (cutoff ? c.filter((k) => k.t < cutoff) : c);
  const maxSymbols = Math.max(4, Math.min(30, Number(opts.maxSymbols) || 16));
  const step = Math.max(1, Number(opts.step) || 2);
  const { coins } = await fetchMarkets();
  const capMap = new Map(coins.map((c) => [c.symbol, c]));
  // an explicit symbol list (research payload) overrides the volume ranking
  const wanted = Array.isArray(opts.symbols) && opts.symbols.length ? opts.symbols.map((s) => String(s).toUpperCase()) : null;
  const ranked = (wanted || coins.slice().sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0)).map((c) => c.symbol))
    .filter((s) => s !== "BTC")
    .slice(0, maxSymbols - 1);
  const universe = [{ symbol: "BTC", name: "Bitcoin" }, ...ranked.map((s) => capMap.get(s) || { symbol: s, name: s })];

  const btcCandles = sliceCandles(await fetchCandlesHistory("BTC", "1h", fetchMonths));
  const btcByTime = btcRegimeMap(btcCandles);
  const btcLeadByTime = btcLeadMap(btcCandles);

  const variants = opts.variants || DEFAULT_VARIANTS;
  const btcSmaMaps = new Map();
  for (const cfg of variants) {
    const bars = Number(cfg.btc_trend_bars) || 0;
    if (bars && !btcSmaMaps.has(bars)) btcSmaMaps.set(bars, btcSmaMap(btcCandles, bars));
  }
  const btcRunByTime = btcRunMap(btcCandles);
  const prepared = [];
  const failures = [];
  const need = WARMUP + 7 * BARS_PER_DAY + 2;
  const tryFetch = async (coin) => {
    const value = sliceCandles(await fetchCandlesHistory(coin.symbol, "1h", fetchMonths));
    if (value && value.length >= need) {
      const rowsByJ = prepSymbol(coin, value, BARS_PER_DAY, step);
      prepared.push({ coin, candles: value, rowsByJ });
      return true;
    }
    return false;
  };
  for (const group of chunk(universe, 6)) {
    const settled = await Promise.allSettled(group.map(tryFetch));
    settled.forEach((res, i) => {
      if (res.status !== "fulfilled" || res.value === false) failures.push({ symbol: group[i].symbol, candles: 0 });
    });
  }
  // one quiet retry pass for the symbols the burst dropped, spaced small groups
  if (failures.length) {
    const retryList = failures.splice(0, failures.length).map((f) => universe.find((u) => u.symbol === f.symbol));
    for (const group of chunk(retryList, 3)) {
      await new Promise((r) => setTimeout(r, 1500));
      const settled = await Promise.allSettled(group.map(tryFetch));
      settled.forEach((res, i) => {
        if (res.status !== "fulfilled" || res.value === false) failures.push({ symbol: group[i].symbol, candles: 0 });
      });
    }
  }

  const slots = {};
  for (const { coin, candles, rowsByJ } of prepared) {
    for (const cfg of variants) {
      const slot = (slots[cfg.id] = slots[cfg.id] || []);
      slot.push(...simulate(candles, rowsByJ, cfg, btcByTime, btcLeadByTime, btcSmaMaps, btcRunByTime));
    }
  }

  const variantsOut = {};
  for (const cfg of variants) {
    const trades = slots[cfg.id] || [];
    variantsOut[cfg.id] = { description: cfg.description, ...metricsFor(trades) };
  }
  const sampleDays = prepared.length
    ? Math.round(Math.min(...prepared.map((p) => (p.candles.length - WARMUP) / BARS_PER_DAY)))
    : 0;
  return {
    months,
    end_offset_months: endOffset,
    days: sampleDays,
    symbols: prepared.length,
    symbols_used: prepared.map((p) => p.coin.symbol),
    step,
    fetch_failures: failures.map((f) => f.symbol),
    variants: variantsOut,
  };
}

// The experiment board: the live engine's rules as the reference, then four
// flat-tape ideas plus the "gate removed" control.
export const DEFAULT_VARIANTS = [
  flatCfg("ref_live_combo", "Reference: the live engine's combo rules as they run today", {
    min_score: 70,
    min_adx: 28,
    min_vol_ratio: 2,
    max_vol_ratio: 4,
    stoch_must_agree: true,
    rsi_chase_block: true,
    min_body: 0.6,
    regime_in: ["risk_off"], // longs only in risk-off; shorts are blocked by the live desk, so longs only
    require_di_owned: true,
    max_stretch_pct: 5,
    target_r: 4.5,
    be_stop_r: 1.2,
    cooldown_bars: 72,
  }),
  flatCfg("flat_momo_scalp", "Flat tape only: momentum scalp, 1.5R target, break-even at 1R, fast cut of underwater trades", {
    regime_in: ["sideways"],
    min_score: 65,
    min_adx: 20,
    require_di_owned: true,
    min_vol_ratio: 1.5,
    max_stretch_pct: 5,
    stoch_must_agree: true,
    rsi_chase_block: true,
    min_body: 0.5,
    target_r: 1.5,
    be_stop_r: 1,
    time_underwater_bars: 12,
    time_flat_bars: 24,
    cooldown_bars: 12,
  }),
  flatCfg("flat_btc_lead", "Flat tape only: follow BTC's last 1h bar (long after BTC rises, short after it falls), 1.5R target", {
    regime_in: ["sideways"],
    btc_lead_pct: 0.3,
    min_score: 60,
    min_vol_ratio: 1.2,
    target_r: 1.5,
    be_stop_r: 1,
    time_underwater_bars: 12,
    time_flat_bars: 24,
    cooldown_bars: 6,
  }),
  flatCfg("flat_meanrev", "Flat tape only: fade the range (long at the bottom of the 20-bar range, short at the top), 1.2R target", {
    regime_in: ["sideways"],
    range_favorable: 0.25,
    min_score: 60,
    min_vol_ratio: 1.2,
    max_stretch_pct: 0,
    target_r: 1.2,
    be_stop_r: 0,
    time_underwater_bars: 8,
    time_flat_bars: 16,
    cooldown_bars: 6,
  }),
  flatCfg("combo_noregime", "Control: the combo stack unchanged but the BTC regime gate removed (all tapes)", {
    min_score: 70,
    min_adx: 28,
    min_vol_ratio: 2,
    max_vol_ratio: 4,
    stoch_must_agree: true,
    rsi_chase_block: true,
    min_body: 0.6,
    require_di_owned: true,
    max_stretch_pct: 5,
    target_r: 4.5,
    be_stop_r: 1.2,
    cooldown_bars: 72,
  }),
  flatCfg("flat_combo_scalp", "Flat tape only: the combo stack with a 1.5R target instead of 4.5R", {
    regime_in: ["sideways"],
    min_score: 70,
    min_adx: 28,
    min_vol_ratio: 2,
    max_vol_ratio: 4,
    stoch_must_agree: true,
    rsi_chase_block: true,
    min_body: 0.6,
    require_di_owned: true,
    max_stretch_pct: 5,
    target_r: 1.5,
    be_stop_r: 1.2,
    time_underwater_bars: 12,
    time_flat_bars: 24,
    cooldown_bars: 24,
  }),
];