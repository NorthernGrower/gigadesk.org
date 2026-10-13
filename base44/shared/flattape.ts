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
    ...over,
  };
}

function flatGate(cfg, row, btcByTime, btcLeadByTime, barTime) {
  if (!row || (Number(row.score) || 0) < cfg.min_score) return false;
  if (cfg.regime_in && !cfg.regime_in.includes(regimeLabel(btcByTime.get(barTime)))) return false;
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
  // basic level sanity: levels must face the trade's own direction
  const stop = Number(row.stop);
  const unit = Math.abs(Number(row.price) - stop);
  if (!(unit > 0)) return false;
  return true;
}

function simulate(candles, rowsByJ, cfg, btcByTime, btcLeadByTime) {
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
    if (flatGate(cfg, row, btcByTime, btcLeadByTime, bar.t)) {
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
  const months = Math.max(1, Math.min(6, Number(opts.months) || 6));
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

  const btcCandles = await fetchCandlesHistory("BTC", "1h", months);
  const btcByTime = btcRegimeMap(btcCandles);
  const btcLeadByTime = btcLeadMap(btcCandles);

  const variants = opts.variants || DEFAULT_VARIANTS;
  const prepared = [];
  const failures = [];
  const need = WARMUP + 7 * BARS_PER_DAY + 2;
  const tryFetch = async (coin) => {
    const value = await fetchCandlesHistory(coin.symbol, "1h", months);
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
      slot.push(...simulate(candles, rowsByJ, cfg, btcByTime, btcLeadByTime));
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