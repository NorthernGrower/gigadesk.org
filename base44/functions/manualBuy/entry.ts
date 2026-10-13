import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchLivePrices, asArray, round } from "../../shared/market.ts";
import { placeMarketOrder, resolveLiveConnection } from "../../shared/orders.ts";
import { readAccount, pickFundingQuote, fetchMarketConstraints, fetchListedSymbols, isBackedOff } from "../../shared/exchanges.ts";
import { entryMinimum } from "../../shared/entryRules.ts";

/**
 * A manual buy from the scanner: a real market order on the connected
 * exchange. It skips the bot's entry gates entirely — no BTC gate, no score
 * bar — and opens in manual mode (bot_handling off): the desk leaves the
 * trade alone until bot handling is switched on for it, and even then the
 * bot manages the sell logic only (stop, target, trailing — never a
 * sentiment flip or thesis-decay close).
 */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const symbol = String(body.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const usd = Number(body.usd) || 0;
    if (!symbol) return Response.json({ error: "A coin symbol is required" }, { status: 400 });
    if (!(usd >= 10)) return Response.json({ error: "The order must be at least 10 USD" }, { status: 400 });

    const config = asArray(
      await base44.entities.BotConfig.filter(
        { created_by_id: user.id },
        { sort: "-updated_date", limit: 1 },
      ),
    )[0];
    if (!config) return Response.json({ error: "Save bot rules before buying" }, { status: 400 });

    // a manual buy needs a verified, trading-enabled exchange account. It is
    // a user-initiated order, so it works even while the bot's real orders
    // are paused — the pause gates the bot's own entries, never the user's hand
    const live = await resolveLiveConnection(base44, config, { manage: true });
    if (!live.conn || !live.info || live.info.status !== "connected" || live.info.allow_trading !== true) {
      return Response.json(
        { error: live.reason || "No verified exchange account with trading enabled" },
        { status: 409 },
      );
    }
    const connRow = await base44.asServiceRole.entities.ExchangeConnection
      .get(live.conn.id)
      .catch(() => null);
    if (isBackedOff(connRow)) {
      return Response.json(
        { error: `${live.conn.label} is temporarily locked after failed attempts — try again after ${connRow.backoff_until}` },
        { status: 409 },
      );
    }

    const acct = await readAccount({
      exchange: live.conn.exchange,
      testnet: live.conn.testnet,
      api_key: live.conn.api_key,
      api_secret: live.conn.api_secret,
      passphrase: live.conn.passphrase || "",
    });
    if (!acct.ok) return Response.json({ error: `Could not read the account: ${acct.message}` }, { status: 502 });
    const funding = pickFundingQuote(acct.balances, live.conn.exchange);
    const spendable = funding ? funding.amount : 0;

    // only buy in a market the account can actually settle — ordering an
    // unlisted symbol is a refused signed call and can lock the key
    const listed = await fetchListedSymbols(live.conn, funding ? [funding.asset] : null);
    if (listed && !listed.has(symbol)) {
      return Response.json(
        { error: `${symbol} is not listed on ${live.conn.label} in your funding currency (${funding?.asset || "quote"})` },
        { status: 409 },
      );
    }

    const [pxMap, constraints] = await Promise.all([
      fetchLivePrices([symbol]),
      fetchMarketConstraints(live.conn),
    ]);
    const entry = Number(pxMap.get(symbol)) || 0;
    if (!(entry > 0)) return Response.json({ error: `No live price for ${symbol} right now` }, { status: 502 });
    const minimum = entryMinimum(constraints, symbol, funding?.asset || "USDT", entry);
    if (usd < minimum) {
      return Response.json(
        { error: `The order is below ${symbol}'s exchange minimum of ${round(minimum, 2)} USD` },
        { status: 400 },
      );
    }
    if (usd > spendable * 0.995) {
      return Response.json(
        { error: `Only ${round(spendable, 2)} ${funding?.asset || "quote"} is spendable on ${live.conn.label}` },
        { status: 400 },
      );
    }

    const buy = await placeMarketOrder(live.conn, {
      symbol,
      side: "buy",
      usd: round(usd, 2),
      price: entry,
    });
    if (!buy.ok) return Response.json({ error: `The exchange refused the order: ${buy.message}` }, { status: 502 });

    const avg = Number(buy.avg_price) || entry;
    const qty = Number(buy.filled_qty) || usd / entry;
    const size = round(qty * avg) || round(usd);

    // the stop and target sit at the live desk's own stop rule, so turning
    // bot handling on later hands the trade sensible sell logic
    const LR = config.live_rules || {};
    const stopPct = Math.min(50, Number(LR.default_stop_pct ?? config.default_stop_pct ?? 2.5)) || 2.5;
    const stop = round(avg * (1 - stopPct / 100), 8);
    const targetR = 2.5;
    const target = round(avg + (avg - stop) * targetR, 8);

    const created = await base44.entities.Trade.create({
      symbol,
      side: "long",
      mode: "real",
      status: "open",
      manual: true,
      bot_handling: false,
      entry_price: round(avg, 8),
      quantity: round(qty, 8),
      size_usd: size,
      stop_price: stop,
      target_price: target,
      target_r: targetR,
      peak_price: round(avg, 8),
      exchange: live.conn.exchange,
      exchange_order_id: buy.order_id,
      rationale: "Manual buy from the scanner",
      opened_at: new Date().toISOString(),
    });
    await base44.entities.Alert.create({
      symbol,
      title: `Manual buy: ${symbol}`,
      message: `Bought ${round(qty, 8)} at ${round(avg, 6)} on ${live.conn.label} (${size} USD). Manual mode is on — the desk leaves this trade alone until bot handling is switched on.`,
      mode: "live",
      kind: "bot_open",
      severity: "info",
      trade_id: created.id,
    });
    return Response.json({
      ok: true,
      trade_id: created.id,
      symbol,
      entry: round(avg, 8),
      quantity: round(qty, 8),
      size_usd: size,
      stop,
      target,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}