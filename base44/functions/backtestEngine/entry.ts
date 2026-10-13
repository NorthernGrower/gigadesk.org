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

// Round 17: builds on the round-16 winner (quality stack + score 68, no flat
// time exit). Tests exit targets, stop management, and the cheaper-fill lever:
// entering on a limit a fraction below/above the signal bar instead of paying
// the close.
const R16_BEST = { ...R14_STACK, min_score: 68, time_flat_bars: 0 };
const ROUND17_VARIANTS = [
  variantCfg("r16_best", "Reference: the round-16 winner (quality stack + score 68, no time exit)", R16_BEST),
  variantCfg("r17_t2", "Winner + 2R targets", { ...R16_BEST, target_r: 2 }),
  variantCfg("r17_t3", "Winner + 3R targets", { ...R16_BEST, target_r: 3 }),
  variantCfg("r17_trail", "Winner + ATR trailing stop after +1.5R", { ...R16_BEST, trail_r: 1.5 }),
  variantCfg("r17_be15", "Winner + break-even after +1.5R", { ...R16_BEST, be_stop_r: 1.5 }),
  variantCfg("r17_champ_notime", "Live champion with only the flat time exit removed", {
    ...CHAMPION,
    time_flat_bars: 0,
  }),
  variantCfg("r17_limit05", "Winner + limit entry 0.5% better than the signal close", {
    ...R16_BEST,
    entry_limit_pct: 0.5,
  }),
  variantCfg("r17_limit10", "Winner + limit entry 1% better than the signal close", {
    ...R16_BEST,
    entry_limit_pct: 1,
  }),
];

// Round 18: locks in the round-17 winner (break-even at +1.5R) and probes the
// last measurable leak: trades opened into a flat BTC tape, plus tighter and
// looser break-even placement.
const R17_BEST = { ...R16_BEST, be_stop_r: 1.5 };
const ROUND18_VARIANTS = [
  variantCfg("r17_be15", "Reference: the round-17 winner", R17_BEST),
  variantCfg("r18_no_sideways", "Winner + no trades opened into a flat BTC tape", {
    ...R17_BEST,
    skip_sideways: true,
  }),
  variantCfg("r18_be12", "Winner + break-even earlier, at +1.2R", { ...R17_BEST, be_stop_r: 1.2 }),
  variantCfg("r18_be20", "Winner + break-even later, at +2.0R", { ...R17_BEST, be_stop_r: 2 }),
  variantCfg("r18_be15_trail2", "Winner + ATR trail after +2.0R", { ...R17_BEST, trail_r: 2 }),
  variantCfg("r18_be15_rr15", "Winner + minimum 1.5R setups only", { ...R17_BEST, min_rr: 1.5 }),
  variantCfg("r18_be15_s72", "Winner + score bar 72", { ...R17_BEST, min_score: 72 }),
];

// Round 19: combos of the two round-18 winners — flat-tape skip and later
// break-even — to settle the final stack.
const R18_BEST = { ...R17_BEST, skip_sideways: true };
const ROUND19_VARIANTS = [
  variantCfg("r18_no_sideways", "Reference: flat-tape skip (round-18 winner)", R18_BEST),
  variantCfg("r19_nosid_be20", "Flat-tape skip + break-even at +2.0R", { ...R18_BEST, be_stop_r: 2 }),
  variantCfg("r19_nosid_be15", "Flat-tape skip + break-even at +1.5R (sanity)", R18_BEST),
  variantCfg("r19_nosid_t3", "Flat-tape skip + 3R targets", { ...R18_BEST, target_r: 3 }),
  variantCfg("r19_be20_nosid", "Break-even at +2.0R + flat-tape skip (same stack, ordering check)", {
    ...R17_BEST,
    be_stop_r: 2,
    skip_sideways: true,
  }),
];

// Round 20: pre-move detection on the settled round-19 stack. Professional
// tells that a move is about to start: a quiet range the signal bar breaks
// out of, volatility squeezed into the bottom of its own history, the entry
// sitting low in the recent range (longs) rather than chasing, conviction
// candles, liquid-session timing, and an upper volume band to avoid
// blow-off exhaustion prints.
const R19_BEST = { ...R18_BEST, be_stop_r: 2 };
const ROUND20_VARIANTS = [
  variantCfg("r19_best", "Reference: the round-19 winner", R19_BEST),
  variantCfg("r20_volband", "Winner + volume band 2x-4x (skip blow-off exhaustion volume)", {
    ...R19_BEST,
    max_vol_ratio: 4,
  }),
  variantCfg("r20_lowrange", "Winner + longs only from the lower half of the 20-bar range", {
    ...R19_BEST,
    range_favorable: 0.5,
  }),
  variantCfg("r20_breakout", "Winner + the signal bar must close at a fresh 20-bar extreme", {
    ...R19_BEST,
    require_breakout: true,
  }),
  variantCfg("r20_squeeze", "Winner + volatility squeezed (Bollinger width in its bottom 40%)", {
    ...R19_BEST,
    max_bb_width_low: 40,
  }),
  variantCfg("r20_sqz_brk", "Winner + squeeze OR breakout: fresh 20-bar extreme with calm width", {
    ...R19_BEST,
    max_bb_width_low: 45,
    require_breakout: true,
  }),
  variantCfg("r20_session", "Winner + entries only 13:00-21:00 UTC (liquid US hours)", {
    ...R19_BEST,
    entry_hours: [13, 21],
  }),
  variantCfg("r20_body", "Winner + conviction candles (body at least 60% of the bar's range)", {
    ...R19_BEST,
    min_body: 0.6,
  }),
  variantCfg("r20_value", "Winner + entry within 2% of the 20-bar EMA (no chasing)", {
    ...R19_BEST,
    max_stretch_pct: 2,
  }),
  variantCfg("r20_score70", "Winner + score bar 70", { ...R19_BEST, min_score: 70 }),
];

// Round 21: stacks the round-20 winners (conviction candles, the volatility
// squeeze, the upper volume band) and probes the threshold edges of each.
const R20_BEST = { ...R19_BEST, min_body: 0.6 };
const ROUND21_VARIANTS = [
  variantCfg("r20_body", "Reference: conviction candles (round-20 winner)", R20_BEST),
  variantCfg("r21_body50", "Conviction threshold lowered to 50% (more trades)", { ...R20_BEST, min_body: 0.5 }),
  variantCfg("r21_body70", "Conviction threshold raised to 70%", { ...R20_BEST, min_body: 0.7 }),
  variantCfg("r21_body_sqz", "Conviction candles + volatility squeeze (bottom 40% width)", {
    ...R20_BEST,
    max_bb_width_low: 40,
  }),
  variantCfg("r21_body_sqz50", "Conviction candles + squeeze (bottom 50% width)", {
    ...R20_BEST,
    max_bb_width_low: 50,
  }),
  variantCfg("r21_body_volband", "Conviction candles + volume band (skip blow-off volume)", {
    ...R20_BEST,
    max_vol_ratio: 4,
  }),
  variantCfg("r21_body_t3", "Conviction candles + 3R targets", { ...R20_BEST, target_r: 3 }),
];

// Round 22: target distance on the conviction stack. With winners surviving
// the conviction filter, larger targets and a trailing stop get retested —
// and the upper volume band stacks on the round-21 winner.
const R21_BEST = { ...R20_BEST, target_r: 3 };
const ROUND22_VARIANTS = [
  variantCfg("r21_body_t3", "Reference: conviction candles + 3R targets", R21_BEST),
  variantCfg("r22_t3_volband", "3R stack + volume band (skip blow-off volume)", {
    ...R21_BEST,
    max_vol_ratio: 4,
  }),
  variantCfg("r22_t4", "Conviction candles + 4R targets", { ...R20_BEST, target_r: 4 }),
  variantCfg("r22_t2p5", "Conviction candles + 2.5R targets", { ...R20_BEST, target_r: 2.5 }),
  variantCfg("r22_t3_trail", "3R stack + ATR trailing stop after +1.5R", { ...R21_BEST, trail_r: 1.5 }),
  variantCfg("r22_t3_be25", "3R stack + break-even later, at +2.5R", { ...R21_BEST, be_stop_r: 2.5 }),
  variantCfg("r22_t3_nobe", "3R stack + break-even removed", { ...R21_BEST, be_stop_r: null }),
];

// Round 23: the 4R jump. Pushes the target further, retests the round-22
// winners on top of it, and re-checks the squeeze now that entries are rare.
const R22_BEST = { ...R20_BEST, target_r: 4 };
const ROUND23_VARIANTS = [
  variantCfg("r22_t4", "Reference: conviction candles + 4R targets", R22_BEST),
  variantCfg("r23_t5", "Conviction candles + 5R targets", { ...R20_BEST, target_r: 5 }),
  variantCfg("r23_t4_volband", "4R stack + volume band (skip blow-off volume)", {
    ...R22_BEST,
    max_vol_ratio: 4,
  }),
  variantCfg("r23_t4_trail", "4R stack + ATR trailing stop after +1.5R", { ...R22_BEST, trail_r: 1.5 }),
  variantCfg("r23_t4_trail2", "4R stack + ATR trailing stop after +2.0R", { ...R22_BEST, trail_r: 2 }),
  variantCfg("r23_t4_sqz50", "4R stack + squeeze (bottom 50% width)", { ...R22_BEST, max_bb_width_low: 50 }),
];

// Round 24: the go-live check. Does the round-23 stack stay profitable when
// it runs WITH the live engine's champion refinements and V2 structural gate
// (it always did — both are baked into the stack), and how much do the live
// engine's own hardcoded levels (2.5R target, break-even at +1.2R) matter?
const R23_BEST = { ...R22_BEST, max_vol_ratio: 4 };
const ROUND24_VARIANTS = [
  variantCfg("champ_live", "Reference: the live engine's rules as they run today (2.5R targets, break-even at +1.2R, 1.5x volume, risk-off longs only)", CHAMPION),
  variantCfg("r24_new_stack", "Reference: the round-23 champion with the V2 structural gate and champion regime rules active (as built)", R23_BEST),
  variantCfg("r24_v2_off", "Round-23 champion with the V2 structural gate and champion regime rules stripped off", {
    ...R23_BEST,
    htf_must_agree: false,
    htf_must_confirm: false,
    min_adx: 0,
    require_di_owned: false,
    min_confluence: 0,
    no_chasing: false,
    max_stretch_pct: 0,
    skip_riskon_long: false,
    skip_sideways_long: false,
  }),
  variantCfg("r24_be12", "Round-23 champion + break-even moved to +1.2R (the live engine's current placement)", {
    ...R23_BEST,
    be_stop_r: 1.2,
  }),
  variantCfg("r24_t25", "Round-23 champion + 2.5R targets (the live engine's current target)", {
    ...R23_BEST,
    target_r: 2.5,
  }),
];

// Round 25: the COMBINED engine. Every independent winner from rounds 14-24
// stacked into one configuration: the V2 structural gate, the quality stack
// (RSI chase block, stochastic agreement, 2x volume), conviction candles,
// 4R targets, the volume band, flat-tape skip, break-even at +1.2R and no
// flat-time exit. Each candidate then tests ONE further edge from the
// earlier rounds that never got retested on top of the full stack.
const COMBO_BEST = { ...R23_BEST, be_stop_r: 1.2 };
const ROUND25_VARIANTS = [
  variantCfg("combo_base", "Reference: every winner from rounds 14-24 stacked", COMBO_BEST),
  variantCfg("combo_stretch3", "Combo + 3% max stretch above the 20-EMA (tighter chase protection)", {
    ...COMBO_BEST,
    max_stretch_pct: 3,
  }),
  variantCfg("combo_adx28", "Combo + ADX 28 (stronger trend required)", { ...COMBO_BEST, min_adx: 28 }),
  variantCfg("combo_div", "Combo + an opposing RSI divergence vetoes the entry", {
    ...COMBO_BEST,
    div_must_agree: true,
  }),
  variantCfg("combo_slope", "Combo + the EMA50 slope must agree with the trade", {
    ...COMBO_BEST,
    slope_must_agree: true,
  }),
  variantCfg("combo_volband3", "Combo + tighter volume band (2x-3x, skips more blow-off)", {
    ...COMBO_BEST,
    max_vol_ratio: 3,
  }),
  variantCfg("combo_score70", "Combo + score bar 70", { ...COMBO_BEST, min_score: 70 }),
  variantCfg("combo_cool48", "Combo + 2-day cooldown (48 bars, revisit setups sooner)", {
    ...COMBO_BEST,
    cooldown_bars: 48,
  }),
];

// Round 26: stacks the round-25 winner (ADX 28) and probes whether the
// runners-up (score 70, 3% stretch) add on top, plus loosening conviction
// and cooldown now that trend strength carries the quality.
const R25_BEST = { ...COMBO_BEST, min_adx: 28 };
const ROUND26_VARIANTS = [
  variantCfg("combo_adx28", "Reference: ADX 28 (round-25 winner)", R25_BEST),
  variantCfg("combo_a28_s70", "ADX 28 + score bar 70 (round-25 runners-up stacked)", {
    ...R25_BEST,
    min_score: 70,
  }),
  variantCfg("combo_a28_st3", "ADX 28 + 3% max stretch", { ...R25_BEST, max_stretch_pct: 3 }),
  variantCfg("combo_a28_body50", "ADX 28 + conviction loosened to 50% (more trades)", {
    ...R25_BEST,
    min_body: 0.5,
  }),
  variantCfg("combo_a28_t35", "ADX 28 + 3.5R targets", { ...R25_BEST, target_r: 3.5 }),
  variantCfg("combo_a28_t45", "ADX 28 + 4.5R targets", { ...R25_BEST, target_r: 4.5 }),
  variantCfg("combo_a28_cool24", "ADX 28 + 1-day cooldown (24 bars)", { ...R25_BEST, cooldown_bars: 24 }),
  variantCfg("combo_a28_tape_all", "ADX 28 + flat-tape skip removed (trend strength replaces it)", {
    ...R25_BEST,
    skip_sideways: false,
    skip_riskon_long: false,
  }),
];

// Round 27: stacks the round-26 winners (4.5R targets, score 70) and pushes
// the target edge one more notch, plus break-even placement checks.
const R26_BEST = { ...R25_BEST, target_r: 4.5 };
const ROUND27_VARIANTS = [
  variantCfg("combo_a28_t45", "Reference: 4.5R targets (round-26 winner)", R26_BEST),
  variantCfg("combo_t45_s70", "4.5R targets + score bar 70 (round-26 winners stacked)", {
    ...R26_BEST,
    min_score: 70,
  }),
  variantCfg("combo_t5", "5R targets", { ...R25_BEST, target_r: 5 }),
  variantCfg("combo_t5_s70", "5R targets + score bar 70", { ...R25_BEST, target_r: 5, min_score: 70 }),
  variantCfg("combo_t45_body50", "4.5R targets + conviction loosened to 50%", {
    ...R26_BEST,
    min_body: 0.5,
  }),
  variantCfg("combo_t45_be10", "4.5R targets + break-even earlier, at +1.0R", {
    ...R26_BEST,
    be_stop_r: 1,
  }),
  variantCfg("combo_t45_nobe", "4.5R targets + break-even removed", { ...R26_BEST, be_stop_r: null }),
];

// Round 28: stability check. The combined champion (4.5R + score 70 stack)
// re-verified over a wider 10-symbol universe, with the last untested edges
// probed on top. 4.5R + score 70 is the candidate to carry forward; break-
// even stays at +1.2R (inactive at these targets but harmless).
const R27_BEST = { ...R26_BEST, min_score: 70 };
const ROUND28_VARIANTS = [
  variantCfg("combo_final", "Reference: the combined champion (4.5R + score 70 stack)", R27_BEST),
  variantCfg("final_st3", "Champion + 3% max stretch", { ...R27_BEST, max_stretch_pct: 3 }),
  variantCfg("final_div", "Champion + an opposing RSI divergence vetoes the entry", {
    ...R27_BEST,
    div_must_agree: true,
  }),
  variantCfg("final_bb90", "Champion + skip entries when Bollinger width is in its top decile", {
    ...R27_BEST,
    max_bb_width: 90,
  }),
  variantCfg("final_volband3", "Champion + tighter volume band (2x-3x)", {
    ...R27_BEST,
    max_vol_ratio: 3,
  }),
  variantCfg("final_body55", "Champion + conviction loosened to 55%", { ...R27_BEST, min_body: 0.55 }),
];

// ---------------------------------------------------------------------------
// COMBO ENGINE (round 25-28 champion, saved 2026-10-12): every independent
// winner from the optimization sessions stacked into one configuration, then
// stable across two independent data refetches. SAVED SEPARATELY — this is an
// optimizer knob set, NOT wired into the live engines (runBot/scanBoard);
// enabling it live is a deliberate, separate change.
// Backtest: $10,000 -> $11,419.13 (+14.19%) over 6 months on 1h candles, 9
// trades, 77.8% win rate, profit factor 23.56, max drawdown 0.6%, worst
// losing streak 2, avg hold ~22h. Kraken-level costs (0.5% round trip).
// Small-sample caveat: 9 trades in 6 months — monitor live before trusting.
// ---------------------------------------------------------------------------
export const COMBO_ENGINE = { ...R27_BEST };

// ---------------------------------------------------------------------------
// MARGIN ENGINE (settled 2026-10-13, margin optimizer rounds 29-36): the
// combined champion re-targeted to 3R, conviction loosened to 50%, run on
// Kraken spot margin costs over the profitable leverage universe (the 9
// majors + AVAX - widened small caps like GRT/FIL/AAVE/UNI bleed on margin
// fees). 6 months of 1h candles: 17 trades, 70.6% win rate, profit factor
// 6.3, max drawdown 1.4%, worst losing streak 2, avg hold ~17h (rollover
// fees halved vs the 4.5R version). Return scales with leverage: ~+14% at
// 1x, ~+30% at 2x, ~+46% at 3x (drawdown scales the same way). Windows stay
// at 6 months - 12-month runs exceed the platform's CPU allocation.
// Small-sample caveat: 17 trades - treat as promising, not proven.
// Set `leverage` when using it.
// ---------------------------------------------------------------------------
export const MARGIN_ENGINE = {
  ...R27_BEST,
  target_r: 3,
  min_body: 0.5,
  universe: ["BTC", "ETH", "SOL", "XRP", "ADA", "DOT", "LINK", "LTC", "DOGE", "AVAX"],
  margin: true,
};

// ---------------------------------------------------------------------------
// MARGIN MODE: the combined champion simulated as a Kraken spot-margin trader.
// Only the pairs Kraken's AssetPairs endpoint lists with sell leverage (the
// markets a margin account can actually open and short), shorts live because
// margin lending sells without holdings, and Kraken's margin fees on top of
// the round-trip taker assumption: 0.02% opening fee plus a 0.02% rollover
// every 4 hours the position is held.
// ---------------------------------------------------------------------------
const MARGIN_VARIANTS = [
  variantCfg("margin_combo", "The combined champion (4.5R + score 70), longs AND shorts, Kraken margin costs", {
    ...R27_BEST,
    margin: true,
  }),
  variantCfg("margin_long_only", "The combined champion, longs only (what the live rules trade today), margin costs", {
    ...R27_BEST,
    margin: true,
    long_only: true,
  }),
  variantCfg("margin_combo_2x", "The combined champion with shorts, 2x leverage scaling returns", {
    ...R27_BEST,
    margin: true,
    leverage: 2,
  }),
  variantCfg("margin_combo_3x", "The combined champion with shorts, 3x leverage scaling returns", {
    ...R27_BEST,
    margin: true,
    leverage: 3,
  }),
];

// ---------------------------------------------------------------------------
// MARGIN OPTIMIZER ROUNDS: rule candidates simulated on Kraken margin costs
// over the leverage-eligible pairs only, six months of 1h candles. The
// reference is the margin champion from the first margin backtest (4.5R +
// score 70 stack, 2x leverage): +13.2% at 1x, +27.5% at 2x, 14 trades, most
// of the edge from shorts. Each candidate changes ONE thing.
// ---------------------------------------------------------------------------
const M2X = { ...R27_BEST, margin: true, leverage: 2 };
const ROUND29_VARIANTS = [
  variantCfg("m29_ref", "Reference: the margin champion at 2x leverage", M2X),
  variantCfg("m29_shorts_only", "Champion at 2x, shorts only (shorts carried the margin edge)", {
    ...M2X,
    short_only: true,
  }),
  variantCfg("m29_t3", "Champion at 2x + 3R targets (faster books, less rollover)", {
    ...M2X,
    target_r: 3,
  }),
  variantCfg("m29_under12", "Champion at 2x + underwater trades cut after 12 hours (rollover bleed)", {
    ...M2X,
    time_underwater_bars: 12,
  }),
  variantCfg("m29_cool24", "Champion at 2x + 1-day cooldown (more trades)", {
    ...M2X,
    cooldown_bars: 24,
  }),
  variantCfg("m29_be10", "Champion at 2x + break-even earlier, at +1.0R", { ...M2X, be_stop_r: 1 }),
  variantCfg("m29_volband3", "Champion at 2x + tighter volume band (2x-3x)", { ...M2X, max_vol_ratio: 3 }),
  variantCfg("m29_lev1", "Champion at 1x (leverage sanity check)", { ...R27_BEST, margin: true }),
  variantCfg("m29_lev3", "Champion at 3x leverage", { ...M2X, leverage: 3 }),
];

// Round 30: stacks the round-29 winner (3R targets, halved hold time) and
// probes leverage, exit and filter edges on top of it.
const M30_BEST = { ...M2X, target_r: 3 };
const ROUND30_VARIANTS = [
  variantCfg("m30_ref", "Reference: the margin champion at 2x", M2X),
  variantCfg("m30_t3", "Reference: 3R targets (round-29 winner)", M30_BEST),
  variantCfg("m30_t3_lev3", "3R targets + 3x leverage", { ...M30_BEST, leverage: 3 }),
  variantCfg("m30_t25", "3R stack + 2.5R targets", { ...M2X, target_r: 2.5 }),
  variantCfg("m30_t35", "3R stack + 3.5R targets", { ...M2X, target_r: 3.5 }),
  variantCfg("m30_t3_u24", "3R stack + underwater trades cut after 24 hours", {
    ...M30_BEST,
    time_underwater_bars: 24,
  }),
  variantCfg("m30_t3_cool24", "3R stack + 1-day cooldown", { ...M30_BEST, cooldown_bars: 24 }),
  variantCfg("m30_t3_st3", "3R stack + 3% max stretch", { ...M30_BEST, max_stretch_pct: 3 }),
  variantCfg("m30_t3_bb90", "3R stack + skip entries in the top Bollinger-width decile", {
    ...M30_BEST,
    max_bb_width: 90,
  }),
  variantCfg("m30_t3_div", "3R stack + an opposing RSI divergence vetoes the entry", {
    ...M30_BEST,
    div_must_agree: true,
  }),
];

// Round 31: last edges on the settled 3R winner - stop management and width.
const ROUND31_VARIANTS = [
  variantCfg("m31_t3", "Reference: 3R targets at 2x (round-30 winner)", M30_BEST),
  variantCfg("m31_trail", "3R stack + ATR trailing stop after +1.5R", { ...M30_BEST, trail_r: 1.5 }),
  variantCfg("m31_sqz", "3R stack + volatility squeeze (bottom 40% width)", {
    ...M30_BEST,
    max_bb_width_low: 40,
  }),
  variantCfg("m31_stopatr", "3R stack + stop must clear 1x ATR (no noise-tight stops)", {
    ...M30_BEST,
    min_stop_atr: 1,
  }),
  variantCfg("m31_lev2x5", "3R stack at 2.5x leverage", { ...M30_BEST, leverage: 2.5 }),
  variantCfg("m31_lev4", "3R stack at 4x leverage (risk check)", { ...M30_BEST, leverage: 4 }),
];

// Round 32: the settled margin engine re-verified on MORE trades - a 12-month
// window over the widened leverage universe (Kraken's USD-quoted margin pairs,
// 40+ symbols). Leverage ladder for the risk picture.
const M32 = { ...R27_BEST, target_r: 3, margin: true };
const ROUND32_VARIANTS = [
  variantCfg("m32_lev1", "The margin engine at 1x leverage, 12 months", { ...M32, leverage: 1 }),
  variantCfg("m32_lev2", "The margin engine at 2x leverage, 12 months", { ...M32, leverage: 2 }),
  variantCfg("m32_lev3", "The margin engine at 3x leverage, 12 months", { ...M32, leverage: 3 }),
];

// The margin universe found in round 32: the nine original leverage pairs
// stayed profitable while the widened small caps (GRT, FIL, AAVE, UNI, TRX)
// bled - only AVAX earned its seat.
const MAJORS9 = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOT", "LINK", "LTC", "DOGE"];
const MAJORS_AVAX = [...MAJORS9, "AVAX"];

// Round 33: more trades done RIGHT - the majors-only universe over 12 months
// (twice the window) instead of diluting with small caps.
const ROUND33_VARIANTS = [
  variantCfg("m33_lev1_majors", "The margin engine, majors only, 12 months, 1x", {
    ...M32,
    leverage: 1,
    universe: MAJORS9,
  }),
  variantCfg("m33_lev2_majors", "The margin engine, majors only, 12 months, 2x", {
    ...M32,
    leverage: 2,
    universe: MAJORS9,
  }),
  variantCfg("m33_lev3_majors", "The margin engine, majors only, 12 months, 3x", {
    ...M32,
    leverage: 3,
    universe: MAJORS9,
  }),
  variantCfg("m33_lev2_avax", "The margin engine, majors + AVAX, 12 months, 2x", {
    ...M32,
    leverage: 2,
    universe: MAJORS_AVAX,
  }),
];

// Round 34: more trades WITHOUT diluting - loosen the score bar on the
// profitable majors universe, plus one candidate universe with the fresh
// liquid candidates in place of the bleeding small caps.
const ROUND34_VARIANTS = [
  variantCfg("m34_ref", "Reference: majors only, score bar 70, 2x", {
    ...M32,
    leverage: 2,
    universe: MAJORS9,
  }),
  variantCfg("m34_s65", "Majors only + score bar lowered to 65 (more trades)", {
    ...M32,
    leverage: 2,
    universe: MAJORS9,
    min_score: 65,
  }),
  variantCfg("m34_s62", "Majors only + score bar lowered to 62 (even more trades)", {
    ...M32,
    leverage: 2,
    universe: MAJORS9,
    min_score: 62,
  }),
  variantCfg("m34_wide_best", "Fresh liquid universe (majors + AVAX/KAS/TAO/SUI/TIA/INJ), 2x", {
    ...M32,
    leverage: 2,
    universe: [...MAJORS_AVAX, "KAS", "TAO", "SUI", "TIA", "INJ"],
  }),
];

// Round 35: loosen each quality-stack gate one at a time on the settled
// majors+AVAX universe, hunting for profitable extra trades.
const M35 = { ...M32, leverage: 2, universe: MAJORS_AVAX };
const ROUND35_VARIANTS = [
  variantCfg("m35_ref", "Reference: majors + AVAX, score 70 stack, 2x", M35),
  variantCfg("m35_body50", "Conviction loosened to 50%", { ...M35, min_body: 0.5 }),
  variantCfg("m35_nostoch", "Stochastic agreement removed", { ...M35, stoch_must_agree: false }),
  variantCfg("m35_norsi", "RSI chase block removed", { ...M35, rsi_chase_block: false }),
  variantCfg("m35_vol15", "Volume floor lowered to 1.5x", { ...M35, min_vol_ratio: 1.5 }),
  variantCfg("m35_noband", "Upper volume band removed", { ...M35, max_vol_ratio: 0 }),
  variantCfg("m35_cool3", "Cooldown halved to 3 bars", { ...M35, cooldown_bars: 3 }),
];

// Round 36: final check - the settled stack (3R, conviction 50%, majors +
// AVAX) across the leverage ladder on a fresh data refetch.
const M36 = { ...M32, min_body: 0.5, universe: MAJORS_AVAX };
const ROUND36_VARIANTS = [
  variantCfg("m36_lev1", "The settled margin engine at 1x leverage", { ...M36, leverage: 1 }),
  variantCfg("m36_lev2", "The settled margin engine at 2x leverage", { ...M36, leverage: 2 }),
  variantCfg("m36_lev3", "The settled margin engine at 3x leverage", { ...M36, leverage: 3 }),
];

const MARGIN_ROUNDS = { 29: ROUND29_VARIANTS, 30: ROUND30_VARIANTS, 31: ROUND31_VARIANTS, 32: ROUND32_VARIANTS, 33: ROUND33_VARIANTS, 34: ROUND34_VARIANTS, 35: ROUND35_VARIANTS, 36: ROUND36_VARIANTS };

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
          ? Number(body.round) >= 28
            ? ROUND28_VARIANTS
            : Number(body.round) >= 27
            ? ROUND27_VARIANTS
            : Number(body.round) >= 26
            ? ROUND26_VARIANTS
            : Number(body.round) >= 25
            ? ROUND25_VARIANTS
            : Number(body.round) >= 24
            ? ROUND24_VARIANTS
            : Number(body.round) >= 23
            ? ROUND23_VARIANTS
            : Number(body.round) >= 22
              ? ROUND22_VARIANTS
              : Number(body.round) >= 21
              ? ROUND21_VARIANTS
              : Number(body.round) >= 20
              ? ROUND20_VARIANTS
              : Number(body.round) >= 19
              ? ROUND19_VARIANTS
              : Number(body.round) >= 18
              ? ROUND18_VARIANTS
              : Number(body.round) >= 17
              ? ROUND17_VARIANTS
              : Number(body.round) >= 16
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

    // Kraken margin backtest: the combined champion over six months of hourly
    // candles on leverage-eligible Kraken pairs only, with margin fees applied.
    if (body.mode === "margin") {
      const round = Number(body.round) || 0;
      const variants = MARGIN_ROUNDS[round] || MARGIN_VARIANTS;
      const { coins } = await fetchMarkets();
      const result = await runOptimize(coins, variants, {
        maxSymbols: Math.min(Number(body.max_symbols) || 20, 40),
        timeframe: "1h",
        months: Number(body.months) || 6,
        ...(Number(body.step) ? { step: Number(body.step) } : {}),
        ...(Array.isArray(body.symbols) && body.symbols.length ? { symbols: body.symbols } : {}),
        marginOnly: true,
      });
      const saved = await base44.asServiceRole.entities.AuditRun
        .create({
          label: round
            ? `Kraken margin optimizer round ${round} - ${result.days}d, ${result.symbols} leverage pairs`
            : `Kraken margin backtest - ${result.days}d, ${result.symbols} leverage pairs`,
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