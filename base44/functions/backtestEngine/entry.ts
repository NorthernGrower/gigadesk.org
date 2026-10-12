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
const OPTIMIZE_VARIANTS = ROUND12_VARIANTS;

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
      const result = await runOptimize(
        coins,
        body.timeframe === "4h" ? ROUND11_4H_VARIANTS : OPTIMIZE_VARIANTS,
        { maxSymbols: Math.min(Number(body.max_symbols) || 12, 20), timeframe: body.timeframe },
      );
      const saved = await base44.asServiceRole.entities.AuditRun
        .create({
          label: `Kraken optimizer round - ${result.days}d, ${result.symbols} symbols`,
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