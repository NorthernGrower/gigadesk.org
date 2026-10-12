import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, fetchCandles, chunk } from "../../shared/market.ts";
import { analyzeCoin } from "../../shared/strategy.ts";
import { pickCandidates } from "../../shared/scan.ts";
import { runAudit, runOptimize, variantCfg } from "../../shared/audit.ts";

// Optimizer round variants: candidate rule changes, each a pure config over
// the shared Kraken data pass. Edited between rounds as results come in.
const CG2 = {
  htf_must_agree: true, htf_must_confirm: true, min_adx: 25, require_di_owned: true,
  min_confluence: 3, min_vol_ratio: 1.2, max_stretch_pct: 5, no_chasing: true,
};
const BASE = { ...CG2, cooldown_bars: 24 };
// Final check: the round-7 winner and runner-up against the round-2 deep
// selection baseline, over a wider 20-symbol universe for stability.
const WIDE = { ...BASE, target_r: 2.5, be_stop_r: 1.2, skip_riskon_long: true, min_vol_ratio: 1.5, skip_sideways_long: true };
// Round 10 + 11: experiments on the champion (wide universe, risk-off longs
// only, 1.5x volume, 72-bar cooldown) — the live engine's current rules.
// Each candidate is the champion plus one change, so results name the rule
// that helped or hurt. Cooldowns are in bars: 72 on 1h, 18 on 4h = 3 days.
const CHAMPION = { ...WIDE, cooldown_bars: 72 };
const ROUND11_VARIANTS = [
  variantCfg("champ_r8", "Reference: the live engine's rules as they run today", CHAMPION),
  variantCfg("r11_score68", "Champion + score bar 68 (round-10 candidate, retest)", { ...CHAMPION, min_score: 68 }),
  variantCfg("r11_s68_adx28", "Champion + score bar 68 + ADX 28 (quality stacked)", { ...CHAMPION, min_score: 68, min_adx: 28 }),
  variantCfg("r11_s68_stretch3", "Champion + score bar 68 + 3% max stretch", { ...CHAMPION, min_score: 68, max_stretch_pct: 3 }),
  variantCfg("r11_s68_cool96", "Champion + score bar 68 + 96-bar cooldown", { ...CHAMPION, min_score: 68, cooldown_bars: 96 }),
  variantCfg("r11_s68_rr18", "Champion + score bar 68 + minimum 1.8R setups", { ...CHAMPION, min_score: 68, min_rr: 1.8 }),
];
const CHAMPION_4H = { ...CHAMPION, cooldown_bars: 18 };
const ROUND11_4H_VARIANTS = [
  variantCfg("champ4h", "Reference: the live engine's rules on 4h candles", CHAMPION_4H),
  variantCfg("r11_4h_score68", "4h champion + score bar 68", { ...CHAMPION_4H, min_score: 68 }),
  variantCfg("r11_4h_s68_adx28", "4h champion + score bar 68 + ADX 28", { ...CHAMPION_4H, min_score: 68, min_adx: 28 }),
  variantCfg("r11_4h_cool36", "4h champion + 6-day cooldown", { ...CHAMPION_4H, cooldown_bars: 36 }),
];
// Round 12: chart-pattern recognition. The engine now reads classic swing
// patterns (double/triple tops and bottoms, head and shoulders, diamond tops
// and bottoms, triangles, wedges, cups, flags) off the pivot structure, and
// each candidate tests a way of letting the pattern gate entries.
const ROUND12_VARIANTS = [
  variantCfg("champ_r8", "Reference: the live engine's rules as they run today", CHAMPION),
  variantCfg("r12_block_opp", "Champion + skip trades a detected chart pattern opposes", {
    ...CHAMPION,
    pattern_must_agree: true,
  }),
  variantCfg("r12_block_opp_q3", "Champion + skip trades opposed by a strong (3+) chart pattern", {
    ...CHAMPION,
    pattern_block_q: 3,
  }),
  variantCfg("r12_require_support", "Champion + only trade when a chart pattern supports the side", {
    ...CHAMPION,
    pattern_must_support: true,
  }),
  variantCfg("r12_support_q2", "Champion + only trade with a supportive pattern of quality 2+", {
    ...CHAMPION,
    pattern_must_support: true,
    pattern_min_quality: 2,
  }),
];
// Round 13: validates the new live toggle. The champion (rules as they run
// today) against "champion off" — the same structural V2 gate but with the
// champion's refinements stripped: 1.2x volume, config targets, no regime
// gate and no break-even. Confirms the toggle's default (on) is the winner.
const ROUND13_VARIANTS = [
  variantCfg("champ_r8", "Reference: the live engine's rules as they run today", CHAMPION),
  variantCfg("r13_base_v2", "Champion off: base V2 rules (1.2x volume, config targets, no regime gate, no break-even)", {
    ...BASE,
    cooldown_bars: 72,
  }),
];
const OPTIMIZE_VARIANTS = ROUND13_VARIANTS;

// Round 14: lower-timeframe focus. The desk trades 1h, so every candidate is
// the live champion plus ONE change aimed at how 1h setups behave — noise-
// proof stops, faster exits, session filters and agreement gates. Backtested
// over six months of hourly candles.
const ROUND14_VARIANTS = [
  variantCfg("champ_1h", "Reference: the live engine's rules as they run today", CHAMPION),
  variantCfg("r14_stop3", "Champion + stops allowed up to 3.5% (more room for 1h noise)", {
    ...CHAMPION,
    max_stop_pct: 3.5,
  }),
  variantCfg("r14_stop_atr1", "Champion + stop must clear 1x ATR (no noise-tight stops)", {
    ...CHAMPION,
    min_stop_atr: 1,
  }),
  variantCfg("r14_stop_atr15", "Champion + stop must clear 1.5x ATR", { ...CHAMPION, min_stop_atr: 1.5 }),
  variantCfg("r14_cool24", "Champion + 1-day cooldown (revisit fresh 1h setups sooner)", {
    ...CHAMPION,
    cooldown_bars: 24,
  }),
  variantCfg("r14_fast_exit", "Champion + underwater trades cut after 24 hours", {
    ...CHAMPION,
    time_underwater_bars: 24,
  }),
  variantCfg("r14_rsi_chase", "Champion + no longs over RSI 72, no shorts under RSI 28", {
    ...CHAMPION,
    rsi_chase_block: true,
  }),
  variantCfg("r14_div_agree", "Champion + an opposing RSI divergence vetoes the entry", {
    ...CHAMPION,
    div_must_agree: true,
  }),
  variantCfg("r14_slope_agree", "Champion + the EMA50 slope must agree with the trade", {
    ...CHAMPION,
    slope_must_agree: true,
  }),
  variantCfg("r14_stoch_agree", "Champion + the stochastic pair must agree with the trade", {
    ...CHAMPION,
    stoch_must_agree: true,
  }),
  variantCfg("r14_offhours", "Champion + no entries 22:00-06:00 UTC or on weekends", {
    ...CHAMPION,
    skip_overnight: true,
    skip_weekend: true,
  }),
  variantCfg("r14_bb_calm", "Champion + skip entries when Bollinger width is in its top decile", {
    ...CHAMPION,
    max_bb_width: 90,
  }),
  variantCfg("r14_vol2", "Champion + the signal bar needs 2x average volume", {
    ...CHAMPION,
    min_vol_ratio: 2,
  }),
];

// Round 15: stacks the three round-14 winners (RSI chase block, stochastic
// agreement, 2x volume) and tests what each further change adds on top.
const R14_STACK = { ...CHAMPION, rsi_chase_block: true, stoch_must_agree: true, min_vol_ratio: 2 };
const ROUND15_VARIANTS = [
  variantCfg("champ_1h", "Reference: the live engine's rules as they run today", CHAMPION),
  variantCfg("r15_stack3", "Round-14 winners stacked: RSI chase block + stochastic agreement + 2x volume", R14_STACK),
  variantCfg("r15_stack4", "Winners stacked + Bollinger calm filter", { ...R14_STACK, max_bb_width: 90 }),
  variantCfg("r15_target3", "Winners stacked + 3R targets", { ...R14_STACK, target_r: 3 }),
  variantCfg("r15_target2", "Winners stacked + 2R targets (quicker books)", { ...R14_STACK, target_r: 2 }),
  variantCfg("r15_rr15", "Winners stacked + minimum 1.5R setups", { ...R14_STACK, min_rr: 1.5 }),
  variantCfg("r15_score68", "Winners stacked + score bar 68", { ...R14_STACK, min_score: 68 }),
  variantCfg("r15_adx28", "Winners stacked + ADX 28", { ...R14_STACK, min_adx: 28 }),
  variantCfg("r15_longonly", "Winners stacked, longs only", { ...R14_STACK, long_only: true }),
  variantCfg("r15_pullback", "Winners stacked + entries only on true Fibonacci pullbacks", {
    ...R14_STACK,
    require_fib_pullback: true,
  }),
];

// Round 16: exit structure on the round-15 stack. The 6-month window showed
// trades held past 24 hours were the profitable cohort and stop-outs dominate,
// so these candidates trade less often but give surviving positions more room.
const ROUND16_VARIANTS = [
  variantCfg("champ_1h", "Reference: the live engine's rules as they run today", CHAMPION),
  variantCfg("r16_stack", "Round-15 quality stack (reference for this round)", R14_STACK),
  variantCfg("r16_s68_stack", "Quality stack + score bar 68 (round-15 winner, reference)", {
    ...R14_STACK,
    min_score: 68,
  }),
  variantCfg("r16_s68_notime", "Score-68 stack with no flat time exit (winners run)", {
    ...R14_STACK,
    min_score: 68,
    time_flat_bars: 0,
  }),
  variantCfg("r16_s68_time96", "Score-68 stack + flat trades cut after 96 hours", {
    ...R14_STACK,
    min_score: 68,
    time_flat_bars: 96,
  }),
  variantCfg("r16_s68_target4", "Score-68 stack + 4R targets", { ...R14_STACK, min_score: 68, target_r: 4 }),
  variantCfg("r16_s68_score72", "Quality stack + score bar 72", { ...R14_STACK, min_score: 72 }),
  variantCfg("r16_s68_t2_be10", "Score-68 stack + 2R targets + break-even after 1.0R", {
    ...R14_STACK,
    min_score: 68,
    target_r: 2,
    be_stop_r: 1.0,
  }),
];

const FEES_PCT = 0.2; // round-trip spot fees, charged on every simulated trade

/**
 * Walk-forward comparison of the signal engine with and without the structural
 * confluence (Fibonacci, Elliott, zones, breakout staleness). Both variants
 * trade the same bars with the same rules (score >= 62, engine levels, 0.2%
 * fees, 48-bar time exit) so the delta isolates the engine change.
 */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    // one-time audit session: three engine iterations (baseline / A / B) over
    // one fixed historical window, identical markets, sizing, costs and
    // execution rules across all three. Results are saved to AuditRun.
    if (body.mode === "audit") {
      const { coins } = await fetchMarkets();
      const result = await runAudit(coins, {
        timeframe: body.timeframe === "4h" ? "4h" : "1h",
        maxSymbols: Math.min(Number(body.max_symbols) || 12, 20),
      });
      const saved = await base44.asServiceRole.entities.AuditRun
        .create({
          label: `Trade engine audit - ${result.timeframe}, ${result.days}d, ${result.symbols} symbols`,
          ran_at: new Date().toISOString(),
          timeframe: result.timeframe,
          window_days: result.days,
          symbols: result.symbols,
          results: result,
        })
        .catch(() => null);
      return Response.json({ run_id: saved ? saved.id : null, ...result });
    }

    // optimizer rounds: a month of Kraken candles, every candidate rule
    // variant simulated over the same prepared signals
    if (body.mode === "optimize") {
      const { coins } = await fetchMarkets();
      const months = Math.max(0, Number(body.months) || 0);
      const result = await runOptimize(
        coins,
        months
          ? Number(body.round) >= 16
            ? ROUND16_VARIANTS
            : Number(body.round) >= 15
              ? ROUND15_VARIANTS
              : ROUND14_VARIANTS
          : body.timeframe === "4h"
            ? ROUND11_4H_VARIANTS
            : OPTIMIZE_VARIANTS,
        {
          maxSymbols: Math.min(Number(body.max_symbols) || 12, 20),
          timeframe: months ? "1h" : body.timeframe,
          ...(months ? { months } : {}),
        },
      );
      const saved = await base44.asServiceRole.entities.AuditRun
        .create({
          label: months
            ? `Lower-timeframe optimizer round - ${result.days}d, ${result.symbols} symbols`
            : `Kraken optimizer round - ${result.days}d, ${result.symbols} symbols`,
          ran_at: new Date().toISOString(),
          timeframe: "1h",
          window_days: result.days,
          symbols: result.symbols,
          results: result,
        })
        .catch(() => null);
      return Response.json({ run_id: saved ? saved.id : null, ...result });
    }

    const timeframe = body.timeframe === "4h" ? "4h" : "1h";
    const maxSymbols = Math.min(Number(body.max_symbols) || 12, 40);
    const minScore = Number(body.min_score) || 62;
    const barsPerDay = timeframe === "1h" ? 24 : 6;

    const { coins } = await fetchMarkets();
    // the same candidate ranking the bot's scan uses, so the backtest measures
    // the engine on the setups it would actually see
    const universe = pickCandidates(coins, maxSymbols);

    function simulate(candles, coin, variant) {
      let pos = null;
      let cooldownUntil = 0;
      const res = { trades: 0, wins: 0, pnl_pct_sum: 0, curve: [0], peak: 0, max_dd: 0, holds: [] };
      const n = candles.length;
      for (let j = 300; j < n - 1; j++) {
        const bar = candles[j];
        if (pos) {
          const hitStop = pos.side === "long" ? bar.l <= pos.stop : bar.h >= pos.stop;
          const hitTarget = pos.side === "long" ? bar.h >= pos.target : bar.l <= pos.target;
          if (hitStop || hitTarget || j - pos.j >= 48) {
            const exit = hitStop && hitTarget ? pos.stop : hitStop ? pos.stop : hitTarget ? pos.target : bar.c;
            const raw =
              pos.side === "long"
                ? ((exit - pos.entry) / pos.entry) * 100
                : ((pos.entry - exit) / pos.entry) * 100;
            const net = raw - FEES_PCT;
            res.trades += 1;
            res.pnl_pct_sum += net;
            if (net > 0) res.wins += 1;
            res.holds.push(j - pos.j);
            const equity = res.curve[res.curve.length - 1] + net;
            res.curve.push(equity);
            res.peak = Math.max(res.peak, equity);
            res.max_dd = Math.max(res.max_dd, res.peak - equity);
            pos = null;
            cooldownUntil = j + 6;
          }
          continue;
        }
        if (j < cooldownUntil) continue;
        const row = analyzeCoin(coin, candles.slice(0, j + 1), {
          medianChange24h: 0,
          dailyTargetPct: 2,
          barsPerDay,
          legacy: variant === "legacy",
          confluenceV2: variant !== "legacy",
        });
        if (row && row.score >= minScore && row.meets_daily_target) {
          pos = { side: row.side, entry: bar.c, stop: row.stop, target: row.target, j };
        }
      }
      return {
        // raw fields feed the cross-symbol aggregation; the derived ones are
        // only for single-symbol use
        trades: res.trades,
        wins: res.wins,
        pnl_pct_sum: res.pnl_pct_sum,
        max_dd: res.max_dd,
        holds: res.holds,
        win_rate: res.trades ? Math.round((res.wins / res.trades) * 100) : 0,
        avg_net_pct: res.trades ? Math.round((res.pnl_pct_sum / res.trades) * 100) / 100 : 0,
        total_net_pct: Math.round(res.pnl_pct_sum * 10) / 10,
        avg_hold_bars: res.holds.length
          ? Math.round(res.holds.reduce((a, b) => a + b, 0) / res.holds.length)
          : 0,
      };
    }

    const perVariant = { legacy: [], confluence: [] };
    for (const group of chunk(universe, 6)) {
      const settled = await Promise.allSettled(
        group.map((c) => fetchCandles(c.symbol, timeframe, 700)),
      );
      settled.forEach((res, i) => {
        if (res.status !== "fulfilled" || !res.value || res.value.length < 400) return;
        perVariant.legacy.push(simulate(res.value, group[i], "legacy"));
        perVariant.confluence.push(simulate(res.value, group[i], "confluence"));
      });
    }

    const summarize = (r) => ({
      trades: r.trades,
      win_rate: r.trades ? Math.round((r.wins / r.trades) * 100) : 0,
      avg_net_pct: r.trades ? Math.round((r.pnl_pct_sum / r.trades) * 100) / 100 : 0,
      total_net_pct: Math.round(r.pnl_pct_sum * 10) / 10,
      max_drawdown_pct: Math.round(r.max_dd * 10) / 10,
      avg_hold_bars: r.holds.length ? Math.round(r.holds.reduce((a, b) => a + b, 0) / r.holds.length) : 0,
    });

    const combine = (list) => ({
      trades: list.reduce((s, r) => s + r.trades, 0),
      wins: list.reduce((s, r) => s + r.wins, 0),
      pnl_pct_sum: list.reduce((s, r) => s + r.pnl_pct_sum, 0),
      max_dd: list.reduce((s, r) => s + r.max_dd, 0),
      holds: list.flatMap((r) => r.holds),
    });
    const a = summarize(combine(perVariant.legacy));
    const b = summarize(combine(perVariant.confluence));
    return Response.json({
      symbols: universe.length,
      timeframe,
      legacy: a,
      confluence: b,
      delta: {
        trades: b.trades - a.trades,
        win_rate: b.win_rate - a.win_rate,
        avg_net_pct: Math.round((b.avg_net_pct - a.avg_net_pct) * 100) / 100,
        max_drawdown_pct: Math.round((b.max_drawdown_pct - a.max_drawdown_pct) * 10) / 10,
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}