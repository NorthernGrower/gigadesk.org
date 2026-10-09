import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { scanBoard, persistSignals, raiseSetupAlerts } from "../../shared/scan.ts";

const TIMEFRAMES = ["15m", "1h", "4h", "1d"];
const SCOPES = ["all", "large", "mid", "small"];

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const timeframe = TIMEFRAMES.includes(body.timeframe) ? body.timeframe : "1h";
    const scope = SCOPES.includes(body.scope) ? body.scope : "all";
    const count = Math.max(20, Math.min(Number(body.count) || 60, 90));
    const dailyTargetPct = Math.max(0.1, Math.min(Number(body.dailyTargetPct) || 2, 50));
    const extraSymbols = Array.isArray(body.symbols)
      ? body.symbols.slice(0, 60).map((s) => String(s))
      : [];

    const board = await scanBoard({ timeframe, scope, count, dailyTargetPct, extraSymbols });

    let persisted = { created: 0, updated: 0 };
    let alerts = 0;
    if (body.persist) {
      // Saving the board is a side effect: never let it break the scan itself.
      try {
        persisted = await persistSignals(base44, board.rows, timeframe);
        alerts = await raiseSetupAlerts(base44, board.rows);
      } catch (err) {
        persisted = { created: 0, updated: 0, error: String(err && err.message ? err.message : err) };
      }
    }

    return Response.json({ ...board, persisted, alerts });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}