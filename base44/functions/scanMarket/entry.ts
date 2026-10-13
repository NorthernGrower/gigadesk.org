import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { scanBoard, persistSignals, raiseSetupAlerts } from "../../shared/scan.ts";
import { asArray } from "../../shared/market.ts";
import { fetchListedSymbols, pickFundingQuote } from "../../shared/exchanges.ts";
import { decryptSecret } from "../../shared/crypto.ts";

const TIMEFRAMES = ["15m", "1h", "4h", "12h", "1d", "1w", "1M"];
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

    // live desk: when an exchange account is attached for real orders, the
    // scanner only considers coins that exchange actually lists — anything
    // else could never be traded there
    let onlySymbols = null;
    let exchangeFilter = null;
    const configs = asArray(
      await base44.entities.BotConfig.filter({}, { sort: "-updated_date", limit: 1 }),
    );
    const cfg = configs[0];
    const connectionId = cfg?.live_rules?.real_connection_id || cfg?.real_connection_id;
    if (cfg && connectionId) {
      const stored = await base44.asServiceRole.entities.ExchangeConnection
        .get(connectionId)
        .catch(() => null);
      if (
        stored &&
        (!cfg.created_by_id || stored.created_by_id === cfg.created_by_id) &&
        stored.status === "connected" &&
        stored.allow_trading === true
      ) {
        const conn = {
          exchange: stored.exchange,
          testnet: Boolean(stored.testnet),
          api_key: await decryptSecret(stored.api_key),
          api_secret: await decryptSecret(stored.api_secret),
          passphrase: await decryptSecret(stored.passphrase || ""),
        };
        const funding = pickFundingQuote(stored.balances, stored.exchange);
        const listed = await fetchListedSymbols(conn, funding ? [funding.asset] : null);
        if (listed && listed.size) {
          onlySymbols = listed;
          exchangeFilter = { exchange: stored.exchange, label: stored.label || stored.exchange, listed: listed.size };
        }
      }
    }

    const board = await scanBoard({
      timeframe,
      scope,
      count,
      dailyTargetPct,
      extraSymbols,
      ...(onlySymbols ? { onlySymbols } : {}),
      db: base44.asServiceRole,
    });

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

    return Response.json({ ...board, persisted, alerts, exchangeFilter });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}