import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { scanBoard, persistSignals, raiseSetupAlerts, resolveDeskVenue } from "../../shared/scan.ts";
import { asArray } from "../../shared/market.ts";
import { fetchListedSymbols, pickFundingQuote } from "../../shared/exchanges.ts";

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

    // the venue the desk actually trades on: the scanner reads that exchange's
    // own market, candles and listing, so coins only that venue lists are
    // scanned instead of silently missing from the US feed
    let onlySymbols = null;
    let exchangeFilter = null;
    const configs = asArray(
      await base44.entities.BotConfig.filter({}, { sort: "-updated_date", limit: 1 }),
    );
    const cfg = configs[0];
    const venue = await resolveDeskVenue(base44, cfg || {});
    if (venue) {
      const conn = {
        exchange: venue.exchange,
        testnet: venue.testnet,
        api_key: "",
        api_secret: "",
        passphrase: "",
      };
      const funding = pickFundingQuote(venue.balances, venue.exchange);
      const listed = await fetchListedSymbols(conn, funding ? [funding.asset] : null);
      if (listed && listed.size) {
        onlySymbols = listed;
        exchangeFilter = { exchange: venue.exchange, label: venue.label, listed: listed.size };
      }
    }

    const board = await scanBoard({
      timeframe,
      scope,
      count,
      dailyTargetPct,
      extraSymbols,
      ...(onlySymbols ? { onlySymbols } : {}),
      feed: venue,
      db: base44.asServiceRole,
    });

    // when the connected exchange's listing filter ran, every row is a coin
    // that exchange actually lists — tag it so the scanner only offers the
    // manual buy (a real order) on tradeable coins
    if (exchangeFilter) {
      for (const row of board.rows || []) row.listed_on = exchangeFilter.exchange;
    }

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