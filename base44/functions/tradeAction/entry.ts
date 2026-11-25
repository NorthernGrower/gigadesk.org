import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, asArray, round } from "../../shared/market.ts";
import { placeMarketOrder, resolveLiveConnection } from "../../shared/orders.ts";
import { readAccount, pickFundingQuote, pickBtcBalance, fetchMarketConstraints, fetchListedSymbols } from "../../shared/exchanges.ts";
import { entryMinimum, liveEntrySize } from "../../shared/entryRules.ts";
import { recordLesson } from "../../shared/learn.ts";
import { liveRule } from "../../shared/deskRules.ts";
import { toUsd } from "../../shared/quotes.ts";

/**
 * Exit maths shared by the single close and the close-everything action.
 * `price` is in the trade's own quote and `fx` is the USD value of one unit
 * of it: a BTC-quoted trade's entry and exit are both in bitcoin, so its P&L
 * is the pair's own move, and the dollar figure is that move at the rate
 * given. A USD trade takes the same path with a factor of one.
 */
function closingValues(trade, price, fx = 1) {
  const entry = Number(trade.entry_price) || 0;
  const qty = Number(trade.quantity) || 0;
  const size = Number(trade.size_usd) || 0;
  const quote = trade.quote_asset === "BTC" ? "BTC" : "USD";
  const pnlInQuote = trade.side === "short" ? (entry - price) * qty : (price - entry) * qty;
  const pnl = toUsd(pnlInQuote, quote, fx);
  const pnlPct = size ? (pnl / size) * 100 : 0;
  return {
    update: {
      status: "closed",
      exit_price: round(price, 8),
      pnl_usd: round(pnl),
      pnl_pct: round(pnlPct),
      closed_at: new Date().toISOString(),
      exit_reason: "manual",
    },
    pnl,
    pnlPct,
    size,
    alert: {
      symbol: trade.symbol,
      title: `${trade.symbol} closed manually`,
      message: `Exit ${round(price, 6)}${quote === "BTC" ? " BTC" : ""} — P&L ${round(pnl)} USD (${round(pnlPct)}%).`,
      kind: pnl >= 0 ? "target_hit" : "stop_hit",
      severity: pnl >= 0 ? "success" : "danger",
      trade_id: trade.id,
      mode: trade.mode === "real" ? "live" : "paper",
    },
  };
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const tradeId = String(body.trade_id || "");

    // the config is the requesting user's own: a desk must never spend
    // another user's cash balance
    const config = asArray(
      await base44.entities.BotConfig.filter(
        { created_by_id: user.id },
        { sort: "-updated_date", limit: 1 },
      ),
    )[0];
    const cash = Number(config?.cash_balance) || 0;

    if (action === "close_all") {
      // close-everything closes THIS user's open positions only — a shared
      // read here once closed another user's paper desk with it
      const openTrades = asArray(
        await base44.entities.Trade.filter(
          { status: "open", created_by_id: user.id },
          { limit: 500 },
        ),
      );
      if (!openTrades.length) {
        return Response.json({ ok: true, closed: 0, skipped: 0, pnl_usd: 0, cash: round(cash) });
      }

      const { coins } = await fetchMarkets(base44.asServiceRole);
      const btcUsd = Number(coins.find((c) => c.symbol === "BTC")?.price) || 0;
      const priceOf = (symbol) => coins.find((c) => c.symbol === symbol)?.price;
      // a BTC-quoted position's levels are in bitcoin: its exit is the pair's
      // price at the rate, and its P&L is translated at that same rate
      const fxOf = (t) => (t.quote_asset === "BTC" ? btcUsd : 1);
      const inQuote = (t, priceUsd) => {
        const fx = fxOf(t);
        return fx > 0 ? (Number(priceUsd) || 0) / fx : 0;
      };
      const closeable = openTrades.filter(
        (t) => Number(priceOf(t.symbol)) > 0 && inQuote(t, priceOf(t.symbol)) > 0,
      );
      if (!closeable.length) {
        return Response.json({ error: "No live prices for your open positions right now" }, { status: 502 });
      }

      // closing positions is management: it must work even with new entries paused
      const live = await resolveLiveConnection(base44, config, { manage: true });
      let cashDelta = 0;
      let pnlTotal = 0;
      for (const openTrade of closeable) {
        let closePrice = inQuote(openTrade, priceOf(openTrade.symbol));
        let dustNote = "";
        // a bot-placed real position is closed with a real sell order; a
        // refused order leaves it open and raises an alert
        if (openTrade.mode === "real" && openTrade.exchange_order_id) {
          if (!live.conn) {
            await base44.entities.Alert.create({
              symbol: openTrade.symbol,
              title: `Could not close ${openTrade.symbol} on the exchange`,
              message: live.reason,
              mode: "live",
              kind: "order_failed",
              severity: "danger",
              trade_id: openTrade.id,
            });
            continue;
          }
          // a short closes by buying the base quantity back through the venue's
          // margin route, a long by selling what it holds
          const shortClose = openTrade.side === "short";
          const sell = await placeMarketOrder(live.conn, {
            symbol: openTrade.symbol,
            side: shortClose ? "buy" : "sell",
            quantity: Number(openTrade.quantity) || 0,
            // a BTC-quoted position lives on its own market: the close must
            // sell the pair it was bought on, never the dollar one
            ...(openTrade.quote_asset === "BTC" ? { quote: "BTC" } : {}),
            ...(shortClose
              ? { margin: true, leverage: Number(liveRule(config.live_rules, "margin_leverage", 2)) || 2 }
              : {}),
          });
          // dust: the exchange can never sell this little — book the close on
          // the desk without an order instead of stranding the position
          if (!sell.ok && !sell.dust) {
            await base44.entities.Alert.create({
              symbol: openTrade.symbol,
              title: `Could not close ${openTrade.symbol} on ${live.conn.label}`,
              message: sell.message,
              mode: "live",
              kind: "order_failed",
              severity: "danger",
              trade_id: openTrade.id,
            });
            continue;
          }
          if (sell.dust) {
            dustNote = `The exchange holds ${sell.held_qty} ${openTrade.symbol}, below its minimum sellable amount — closed here without an order.`;
          } else if (sell.avg_price) closePrice = sell.avg_price;
        }
        const closed = closingValues(openTrade, closePrice, fxOf(openTrade));
        if (dustNote) {
          closed.alert.message = `${closed.alert.message} ${dustNote}`;
          closed.alert.severity = "warning";
        }
        await base44.entities.Trade.update(openTrade.id, closed.update);
        if ((openTrade.mode || "paper") === "paper") cashDelta += closed.size + closed.pnl;
        pnlTotal += closed.pnl;
        await base44.entities.Alert.create(closed.alert);
        await recordLesson(base44, openTrade, closed.pnlPct, closed.pnl, closed.update.exit_reason);
      }

      if (config && cashDelta) {
        await base44.entities.BotConfig.update(config.id, { cash_balance: round(cash + cashDelta) });
      }

      return Response.json({
        ok: true,
        closed: closeable.length,
        skipped: openTrades.length - closeable.length,
        pnl_usd: round(pnlTotal),
        cash: round(config ? cash + cashDelta : cash),
      });
    }

    if (!tradeId) return Response.json({ error: "A trade id is required" }, { status: 400 });

    const trade = await base44.entities.Trade.get(tradeId);
    if (!trade || trade.created_by_id !== user.id)
      return Response.json({ error: "Trade not found" }, { status: 404 });
    const isPaper = (trade.mode || "paper") === "paper";

    if (action === "approve") {
      if (trade.status !== "proposed") {
        return Response.json({ error: "This trade is not waiting for approval" }, { status: 409 });
      }
      let size = Number(trade.size_usd) || 0;
      let qty = Number(trade.quantity) || 0;
      if (isPaper && size > cash) {
        size = cash;
        qty = Number(trade.entry_price) ? size / Number(trade.entry_price) : 0;
      }
      if (size <= 0) {
        return Response.json({ error: "Not enough balance to open this position" }, { status: 400 });
      }

      // real orders: confirming a long with real orders on fires a market buy
      // on the chosen exchange, sized by the live risk rules — risk per trade
      // % of the account's spendable quote balance, risked between entry and
      // stop (the same maths as the paper desk). A refused order keeps the
      // proposal standing. A BTC-quoted proposal spends the account's Bitcoin
      // and orders on the pair, so its balance, its floor and its order size
      // are all in BTC, and its dollar figures come from the rate it was
      // proposed at.
      let real = null;
      let realSize = 0;
      const live = await resolveLiveConnection(base44, config);
      if (live.conn && trade.side === "long") {
        const acct = await readAccount({
          exchange: live.conn.exchange,
          testnet: Boolean(live.conn.testnet),
          api_key: live.conn.api_key,
          api_secret: live.conn.api_secret,
          passphrase: live.conn.passphrase || "",
        });
        const isBtcQuote = trade.quote_asset === "BTC";
        const btcUsd = Number(trade.fx_usd) || 0;
        if (isBtcQuote && !(btcUsd > 0)) {
          return Response.json({ error: "This BTC-quoted proposal has no recorded Bitcoin rate" }, { status: 409 });
        }
        const funding = acct.ok ? pickFundingQuote(acct.balances, live.conn.exchange) : null;
        const btcBalance = acct.ok && isBtcQuote ? pickBtcBalance(acct.balances) : 0;
        const balance = isBtcQuote ? btcBalance : funding ? funding.amount : 0;
        const quoteAsset = isBtcQuote ? "BTC" : funding?.asset || "quote";
        const entry = Number(trade.entry_price) || 0;
        // only fire a buy in a market the account can actually settle —
        // ordering an unlisted symbol is a refused signed call and can lock
        // the key, so it is answered here without one
        const listed = await fetchListedSymbols(live.conn, [quoteAsset]);
        if (listed && !listed.has(trade.symbol)) {
          return Response.json(
            { error: `${trade.symbol} is not listed on ${live.conn.label} in your funding currency (${quoteAsset})` },
            { status: 409 },
          );
        }
        const LR = config.live_rules || {};
        const liveRiskPct = Math.min(25, Number(liveRule(LR, "risk_per_trade_pct", 4)) || 4);
        // the same sizing the bot entries use: risked between entry and stop,
        // a fee buffer under the spendable balance, and at or above the
        // pair's exchange minimum so Kraken accepts the volume
        const constraints = await fetchMarketConstraints(live.conn);
        const stop = Number(trade.stop_price) || entry * (1 - (Number(liveRule(LR, "default_stop_pct", 2.5)) || 2.5) / 100);
        const capUsd = Number(liveRule(LR, "live_cap_usd", 0)) || 0;
        const openReal = asArray(
          await base44.entities.Trade.filter({ status: "open", mode: "real" }, { limit: 200 }),
        )
          .filter((t) => t.created_by_id === trade.created_by_id)
          .reduce((a, t) => a + (Number(t.size_usd) || 0), 0);
        const budgetUsd = capUsd > 0 ? Math.max(0, capUsd - openReal) : balance * (isBtcQuote ? btcUsd : 1);
        // the $10 floor in the quote this market settles in
        const floorQuote = isBtcQuote ? round(10 / btcUsd, 8) : 10;
        const sizeQuote = liveEntrySize({
          row: { entry, stop },
          balance,
          budget: isBtcQuote ? budgetUsd / btcUsd : budgetUsd,
          slots: 1,
          riskPct: liveRiskPct,
          minimum: entryMinimum(constraints, trade.symbol, quoteAsset, entry, floorQuote),
          floor: floorQuote,
          decimals: isBtcQuote ? 8 : 2,
        });
        const sizeUsd = isBtcQuote ? sizeQuote * btcUsd : sizeQuote;
        realSize = sizeUsd;
        real =
          sizeUsd >= 10
            ? await placeMarketOrder(live.conn, {
                symbol: trade.symbol,
                side: "buy",
                usd: round(sizeUsd, 2),
                price: entry,
                quantity: round(sizeQuote / entry, 8),
                ...(isBtcQuote ? { quote: "BTC" } : {}),
              })
            : {
                ok: false,
                message:
                  balance < floorQuote
                    ? `No spendable ${quoteAsset} on ${live.conn.label} to fund the order`
                    : `After the risk rules the order sits below ${trade.symbol}'s exchange minimum — raise risk per trade or the budget cap`,
              };
        if (!real.ok) {
          return Response.json({ error: `The exchange refused the order: ${real.message}` }, { status: 502 });
        }
      }

      await base44.entities.Trade.update(tradeId, {
        status: "open",
        ...(real
          ? {
              mode: "real",
              entry_price: round(real.avg_price || Number(trade.entry_price) || 0, 8),
              quantity: round(real.filled_qty || realSize / (Number(trade.entry_price) || 1), 8),
              size_usd: round(realSize),
              exchange: live.conn.exchange,
              exchange_order_id: real.order_id,
            }
          : { size_usd: round(size), quantity: round(qty, 8) }),
        opened_at: new Date().toISOString(),
      });
      if (!real && isPaper && config) {
        await base44.entities.BotConfig.update(config.id, { cash_balance: round(cash - size) });
      }
      return Response.json({ ok: true, status: "open", cash: round(!real && isPaper ? cash - size : cash) });
    }

    if (action === "reject") {
      await base44.entities.Trade.update(tradeId, { status: "rejected" });
      return Response.json({ ok: true, status: "rejected" });
    }

    if (action === "close") {
      if (trade.status !== "open") {
        return Response.json({ error: "Only an open position can be closed" }, { status: 409 });
      }
      const { coins } = await fetchMarkets(base44.asServiceRole);
      // a BTC-quoted position's own market is priced in bitcoin, so its exit
      // and its P&L are translated at the rate — a dollar price compared
      // with a BTC entry would book a nonsense result
      const btcUsd = Number(coins.find((c) => c.symbol === "BTC")?.price) || 0;
      const isBtcQuote = trade.quote_asset === "BTC";
      const fx = isBtcQuote ? btcUsd : 1;
      if (!(fx > 0)) {
        return Response.json({ error: "No live Bitcoin price to close this position" }, { status: 502 });
      }
      const priceUsd = coins.find((c) => c.symbol === trade.symbol)?.price;
      if (!(Number(priceUsd) > 0)) {
        return Response.json({ error: "No live price for this coin right now" }, { status: 502 });
      }
      let closePrice = Number(priceUsd) / fx;
      let dustNote = "";
      // closing a bot-placed real position sends a real sell order first
      if (trade.mode === "real" && trade.exchange_order_id) {
        const live = await resolveLiveConnection(base44, config, { manage: true });
        if (!live.conn) return Response.json({ error: live.reason }, { status: 409 });
        const shortClose = trade.side === "short";
        const sell = await placeMarketOrder(live.conn, {
          symbol: trade.symbol,
          side: shortClose ? "buy" : "sell",
          quantity: Number(trade.quantity) || 0,
          // a BTC-quoted position lives on its own market: the close must
          // sell the pair it was bought on, never the dollar one
          ...(isBtcQuote ? { quote: "BTC" } : {}),
          ...(shortClose
            ? { margin: true, leverage: Number(liveRule(config.live_rules, "margin_leverage", 2)) || 2 }
            : {}),
        });
        // dust: the exchange can never sell this little — book the close on
        // the desk without an order instead of stranding the position
        if (!sell.ok && !sell.dust) {
          return Response.json({ error: `The exchange refused the close: ${sell.message}` }, { status: 502 });
        }
        if (sell.dust) {
          dustNote = `The exchange holds ${sell.held_qty} ${trade.symbol}, below its minimum sellable amount — closed here without an order.`;
        } else if (sell.avg_price) {
          closePrice = sell.avg_price;
        }
      }
      const closed = closingValues(trade, closePrice, fx);
      if (dustNote) {
        closed.alert.message = `${closed.alert.message} ${dustNote}`;
        closed.alert.severity = "warning";
      }
      await base44.entities.Trade.update(tradeId, closed.update);
      if (isPaper && config) {
        await base44.entities.BotConfig.update(config.id, {
          cash_balance: round(cash + closed.size + closed.pnl),
        });
      }
      await base44.entities.Alert.create(closed.alert);
      await recordLesson(base44, trade, closed.pnlPct, closed.pnl, closed.update.exit_reason);

      return Response.json({
        ok: true,
        status: "closed",
        exit_price: closed.update.exit_price,
        pnl_usd: closed.update.pnl_usd,
        pnl_pct: closed.update.pnl_pct,
        cash: round(isPaper ? cash + closed.size + closed.pnl : cash),
      });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}