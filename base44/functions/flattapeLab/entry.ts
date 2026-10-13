import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { runFlatLab, DEFAULT_VARIANTS } from "../../shared/flattape.ts";

// Flat-tape lab: a pure research backtest. Reads public candle history,
// writes nothing to the database, changes nothing in the live engine.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const months = Number(body.months) || 6;
    const maxSymbols = Number(body.max_symbols) || 16;
    const step = Number(body.step) || 2;
    const symbols = Array.isArray(body.symbols) ? body.symbols : null;
    const variants = Array.isArray(body.variants) ? body.variants : DEFAULT_VARIANTS;

    const result = await runFlatLab({ months, maxSymbols, step, symbols, variants });
    // research log: every run is archived so nothing is lost to display limits
    await base44.asServiceRole.entities.AuditRun.create({
      label: `Flat-tape lab: ${months}m 1h, ${result.symbols} symbols, step ${step}`,
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