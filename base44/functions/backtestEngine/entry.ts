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
const R25S = { ...BASE, target_r: 2.5, be_stop_r: 1.2, skip_riskon_long: true, min_vol_ratio: 1.5 };
const OPTIMIZE_VARIANTS = [
  variantCfg("rr25_be12_skipron", "Round 4 break-even anchor: deep selection + cooldown + 2.5R + BE1.2 + no risk-on longs", { ...BASE, target_r: 2.5, be_stop_r: 1.2, skip_riskon_long: true }),
  variantCfg("rr25_be12_v15", "Round 4 winner: deep selection + cooldown + 2.5R + BE1.2 + volume 1.5x", { ...BASE, target_r: 2.5, be_stop_r: 1.2, min_vol_ratio: 1.5 }),
  variantCfg("rr25_be12_skipron_v15", "Both round 4 winners combined", R25S),
  variantCfg("rr25_be12_skipron_v15_cool48", "Combined plus a 48-bar cooldown", { ...R25S, cooldown_bars: 48 }),
  variantCfg("rr25_be12_skipron_v15_sideskip", "Combined plus skipping sideways longs", { ...R25S, skip_sideways_long: true }),
  variantCfg("rr25_be12_skipron_v15_tu36", "Combined plus underwater trades cut at 36 bars", { ...R25S, time_underwater_bars: 36 }),
  variantCfg("rr25_be12_skipron_v15_trail2", "Combined plus a 1.5x-ATR trail after +2R", { ...R25S, trail_r: 2 }),
  variantCfg("rr2_be12_skipron_v15", "Combined with a 2R target", { ...BASE, target_r: 2, be_stop_r: 1.2, skip_riskon_long: true, min_vol_ratio: 1.5 }),
  variantCfg("rr25_be12_skipron_stretch3", "Round 4 anchor with a 3% max stretch", { ...BASE, target_r: 2.5, be_stop_r: 1.2, skip_riskon_long: true, max_stretch_pct: 3 }),
  variantCfg("rr3_be12_skipron_v15", "Combined with a 3R target", { ...BASE, target_r: 3, be_stop_r: 1.2, skip_riskon_long: true, min_vol_ratio: 1.5 }),
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
      const result = await runOptimize(coins, OPTIMIZE_VARIANTS, {
        maxSymbols: Math.min(Number(body.max_symbols) || 12, 20),
      });
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