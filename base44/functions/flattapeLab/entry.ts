import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { runFlatLab, DEFAULT_VARIANTS, metricsFor } from "../../shared/flattape.ts";
import { canWriteAuditLog, auditLabel } from "../../shared/auditlog.ts";

// pool mode takes its trade legs straight from the request body: bounded so one
// call cannot inflate the archived record
const MAX_VARIANTS = 50;
const MAX_LEGS = 5000;

// Flat-tape lab: a pure research backtest. Reads public candle history,
// writes nothing to the database, changes nothing in the live engine.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // every mode below archives its run to AuditRun, the admin-only research
    // log, written with the service role (bypassing that entity's RLS) — so the
    // admin check has to happen here, before any run starts
    if (!canWriteAuditLog(user)) return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));

    // pooling mode: merge the raw trade legs from earlier window runs (same
    // variants, disjoint windows) into one book, so a small sample per window
    // becomes a statistically meaningful verdict. Pure math, no data fetch.
    if (body.mode === "pool" && body.trades && typeof body.trades === "object") {
      const variantsOut = {};
      const input = Object.entries(body.trades).slice(0, MAX_VARIANTS);
      for (const [id, legs] of input) {
        variantsOut[id] = metricsFor(Array.isArray(legs) ? legs.slice(0, MAX_LEGS) : []);
      }
      await base44.asServiceRole.entities.AuditRun
        .create({
          label: auditLabel(body.label || `Flat-tape lab pooled: ${input.length} variants, ${
            input.reduce((a, [, l]) => a + (Array.isArray(l) ? Math.min(l.length, MAX_LEGS) : 0), 0
          )} trade legs`),
          ran_at: new Date().toISOString(),
          timeframe: "1h",
          symbols: 6,
          results: variantsOut,
        })
        .catch(() => null);
      return Response.json({ pooled: true, variants: variantsOut });
    }

    // audit pooling: same job, but the trade legs come straight from the most
    // recent archived return_trades runs instead of the request body
    if (body.mode === "pool_audit") {
      const take = Math.min(Number(body.take) || 3, 6);
      const runs = await base44.asServiceRole.entities.AuditRun.filter({}, { sort: "-ran_at", limit: 50 });
      const runList = Array.isArray(runs) ? runs : runs.items || [];
      const withTrades = runList.filter(
        (r) =>
          (r.label || "").startsWith("Flat-tape lab") &&
          r.results && r.results.variants &&
          Object.values(r.results.variants).some((v) => Array.isArray(v.trades)),
      );
      const selected = withTrades.slice(0, take);
      const merged = {};
      for (const run of selected) {
        for (const [id, v] of Object.entries(run.results.variants)) {
          if (Array.isArray(v.trades)) (merged[id] = merged[id] || []).push(...v.trades);
        }
      }
      const variantsOut = {};
      for (const [id, legs] of Object.entries(merged)) variantsOut[id] = metricsFor(legs);
      await base44.asServiceRole.entities.AuditRun
        .create({
          label: `Flat-tape lab POOLED: ${selected.length} windows, ${Object.keys(merged).length} variants, ${
            Object.values(merged).reduce((a, l) => a + l.length, 0)
          } trade legs`,
          ran_at: new Date().toISOString(),
          timeframe: "1h",
          symbols: 6,
          results: variantsOut,
        })
        .catch(() => null);
      return Response.json({
        pooled: true,
        windows: selected.map((r) => r.label),
        variants: variantsOut,
      });
    }

    const months = Number(body.months) || 6;
    const maxSymbols = Number(body.max_symbols) || 16;
    const step = Number(body.step) || 2;
    const symbols = Array.isArray(body.symbols) ? body.symbols : null;
    const variants = Array.isArray(body.variants) ? body.variants : DEFAULT_VARIANTS;

    const endOffset = Number(body.end_offset_months) || 0;
    const result = await runFlatLab({
      months, maxSymbols, step, symbols, variants, end_offset_months: endOffset,
      return_trades: body.return_trades === true,
    });
    // research log: every run is archived so nothing is lost to display limits
    await base44.asServiceRole.entities.AuditRun.create({
      label: `Flat-tape lab: ${months}m 1h${endOffset ? ` -${endOffset}m` : ""}, ${result.symbols} symbols, step ${step}`,
      ran_at: new Date().toISOString(),
      timeframe: "1h",
      window_days: result.days,
      symbols: result.symbols,
      results: result,
    }).catch(() => null);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}