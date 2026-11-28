import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { scanBoard, persistSignals, raiseSetupAlerts, resolveDeskVenue, resolveBtcVenue, resolveBtcSymbols } from "../../shared/scan.ts";
import { asArray, fetchLivePrices } from "../../shared/market.ts";
import { fetchListedSymbols, pickFundingQuote } from "../../shared/exchanges.ts";

const TIMEFRAMES = ["15m", "1h", "4h", "12h", "1d", "1w", "1M"];
const SCOPES = ["all", "large", "mid", "small"];

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const quote = body.quote === "BTC" ? "BTC" : "USD";
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
    // this user's rules decide which exchange board is scanned; a global read
    // here picked another user's connection and filtered this desk by it
    const configs = asArray(
      await base44.entities.BotConfig.filter(
        { created_by_id: user.id },
        { sort: "-updated_date", limit: 1 },
      ),
    );
    const cfg = configs[0];
    const btcVenue = quote === "BTC" ? await resolveBtcVenue(base44, cfg || {}) : null;
    // in BTC mode the universe is the BTC-pairs list on every connected venue,
    // and its candles come from one of those venues — never the dollar feed
    const venue = quote === "BTC" ? btcVenue : await resolveDeskVenue(base44, cfg || {});
    let btcUsd = 0;
    if (quote === "BTC") {
      const prices = await fetchLivePrices(["BTC"]).catch(() => new Map());
      btcUsd = Number(prices.get("BTC")) || 0;
      // without a rate a BTC pair's turnover has no dollar meaning and the
      // liquidity gate would pass everything, so show why the board is empty
      if (!(btcUsd > 0))
        return Response.json({
          rows: [], scannedCount: 0, universeCount: 0, summary: null,
          medianChange24h: 0, source: { exchange: venue?.exchange || null, quote: "BTC" },
          exchangeFilter: { quote: "BTC", label: venue?.label || "Bitcoin markets", listed: 0 },
          error: "No live Bitcoin price right now — try the scan again in a moment.",
        });
      onlySymbols = await resolveBtcSymbols(base44, cfg || {});
      // an empty result has two different causes and the page must say which:
      // no connected venue lists BTC pairs at all, or one does but the read of
      // its listings came back empty
      if (!venue || !onlySymbols || !onlySymbols.size) {
        return Response.json({
          rows: [], scannedCount: 0, universeCount: 0, summary: null,
          medianChange24h: 0, source: { exchange: venue?.exchange || null, quote: "BTC" },
          exchangeFilter: { quote: "BTC", label: venue?.label || "Bitcoin markets", listed: 0 },
          error: venue
            ? `${venue.label} returned no BTC pairs — check the connection on Settings, or try again in a minute.`
            : "No connected exchange lists BTC pairs. Connect an exchange that trades BTC markets (Kraken, Binance, Bybit or KuCoin) to scan them.",
        });
      }
      exchangeFilter = { quote: "BTC", exchange: venue.exchange, label: venue.label, listed: onlySymbols.size };
    } else if (venue) {
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
      // a watched symbol that is not a BTC pair must never widen the BTC board
      extraSymbols: quote === "BTC" ? [] : extraSymbols,
      ...(onlySymbols && onlySymbols.size ? { onlySymbols } : {}),
      feed: venue,
      db: base44.asServiceRole,
      quote,
      btcUsd,
    });

    // in BTC mode a pair is deliberately shown even when the manual buy is
    // unavailable; other modes tag rows whose venue can settle a real order
    if (exchangeFilter && quote !== "BTC") {
      for (const row of board.rows || []) row.listed_on = exchangeFilter.exchange;
    }

    let persisted = { created: 0, updated: 0 };
    let alerts = 0;
    if (body.persist && quote !== "BTC") {
      // Saving the board is a side effect: never let it break the scan itself.
      try {
        persisted = await persistSignals(base44, board.rows, timeframe);
        alerts = await raiseSetupAlerts(base44, board.rows);
      } catch (err) {
        persisted = { created: 0, updated: 0, error: String(err && err.message ? err.message : err) };
      }
    }

    return Response.json({ ...board, quote, persisted, alerts, exchangeFilter });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}