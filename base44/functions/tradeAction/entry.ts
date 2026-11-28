import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, fetchLivePrices, asArray, round } from "../../shared/market.ts";
import { placeMarketOrder, resolveLiveConnection } from "../../shared/orders.ts";
import { readAccount, pickFundingQuote, pickBtcBalance, fetchMarketConstraints, fetchListedSymbols } from "../../shared/exchanges.ts";
import { entryMinimum, liveEntrySize } from "../../shared/entryRules.ts";
import { excursionOf, outcomeFields, recordLesson, riskPctAt, rulesSnapshot } from "../../shared/learn.ts";
import { liveRule, liveRulesView } from "../../shared/deskRules.ts";
import { btcBookView, btcSpendLimit } from "../../shared/bookRules.ts";
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
  // the close completes the trade's excursion too: the exit is the last print
  // the position saw, so the run it made and the drawdown it took are whole on
  // the row, and the R multiple and hold time go with them
  const ride = excursionOf(trade, trade.side === "short" ? "short" : "long", price);
  return {
    update: {
      status: "closed",
      exit_price: round(price, 8),
      pnl_usd: round(pnl),
      pnl_pct: round(pnlPct),
      ...(ride ? { mfe_price: round(ride.mfe, 8), mae_price: round(ride.mae, 8) } : {}),
      ...outcomeFields(trade, pnlPct),
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
      // the board a desk scans is the exchange's own, so a coin the desk trades
      // can be one the public board no longer lists — closing it must not be
      // refused for that. Every open symbol is priced from the live feed as
      // well, and only a symbol neither source prices is skipped.
      const symbols = [...new Set(openTrades.map((t) => String(t.symbol || "").toUpperCase()))];
      const freshPx = await fetchLivePrices([...symbols, "BTC"]).catch(() => new Map());
      const btcUsd = Number(coins.find((c) => c.symbol === "BTC")?.price) || Number(freshPx.get("BTC")) || 0;
      const priceOf = (symbol) =>
        Number(coins.find((c) => c.symbol === symbol)?.price) ||
        Number(freshPx.get(String(symbol || "").toUpperCase())) ||
        0;
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
        const first = String(openTrades[0]?.symbol || "your position");
        return Response.json(
          { error: `No live price for ${first} right now — nothing was closed, try again in a moment` },
          { status: 502 },
        );
      }

      // closing positions is management: it must work even with new entries paused
      const live = await resolveLiveConnection(base44, config, { manage: true });
      let cashDelta = 0;
      let btcCashDelta = 0;
      let pnlTotal = 0;
      for (const openTrade of closeable) {
        let closePrice = inQuote(openTrade, priceOf(openTrade.symbol));
        let dustNote = "";
        // a real position is closed with a real sell order, whichever way it
        // was opened or imported; a refused order leaves it open and raises an
        // alert
        if (openTrade.mode === "real") {
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
        if ((openTrade.mode || "paper") === "paper") {
          if (openTrade.quote_asset === "BTC") btcCashDelta += closed.size + closed.pnl;
          else cashDelta += closed.size + closed.pnl;
        }
        pnlTotal += closed.pnl;
        await base44.entities.Alert.create(closed.alert);
        await recordLesson(base44, openTrade, closed.pnlPct, closed.pnl, closed.update.exit_reason);
      }

      if (config && btcCashDelta) {
        await base44.entities.BotConfig.update(config.id, { btc_cash_balance: round((Number(config.btc_cash_balance) || 0) + btcCashDelta) });
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
      // a Bitcoin paper proposal is paid from the Bitcoin book's own cash, never the dollar cash
      const isBtcPaper = isPaper && trade.quote_asset === "BTC";
      const paperCash = isBtcPaper ? Number(config?.btc_cash_balance) || 0 : cash;
      if (isPaper && size > paperCash) {
        size = paperCash;
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
        // a Bitcoin proposal is sized by the Bitcoin book's own live risk, and has no dollar cap
        const bookRules = isBtcQuote ? btcBookView(liveRulesView(config), LR.live_btc_rules) : null;
        const liveRiskPct = Math.min(25, Number(bookRules ? bookRules.risk_per_trade_pct : liveRule(LR, "risk_per_trade_pct", 4)) || 4);
        // a Bitcoin proposal spends only what the Bitcoin book allows of the
        // holding — its share and its hard cap — exactly as its entries do
        const spendable = isBtcQuote
          ? btcSpendLimit(balance, (bookRules || {}).btc_use_pct, (bookRules || {}).btc_cap_btc)
          : balance;
        // the same sizing the bot entries use: risked between entry and stop,
        // a fee buffer under the spendable balance, and at or above the
        // pair's exchange minimum so Kraken accepts the volume
        const constraints = await fetchMarketConstraints(live.conn);
        const stop = Number(trade.stop_price) || entry * (1 - (Number(liveRule(LR, "default_stop_pct", 2.5)) || 2.5) / 100);
        const capUsd = isBtcQuote ? 0 : Number(liveRule(LR, "live_cap_usd", 0)) || 0;
        const openReal = asArray(
          await base44.entities.Trade.filter({ status: "open", mode: "real" }, { limit: 200 }),
        )
          .filter((t) => t.created_by_id === trade.created_by_id)
          .reduce((a, t) => a + (Number(t.size_usd) || 0), 0);
        const budgetUsd = capUsd > 0 ? Math.max(0, capUsd - openReal) : spendable * (isBtcQuote ? btcUsd : 1);
        // the $10 floor in the quote this market settles in
        const floorQuote = isBtcQuote ? round(10 / btcUsd, 8) : 10;
        const sizeQuote = liveEntrySize({
          row: { entry, stop },
          balance: spendable,
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
                // the order spends this market's own quote: bitcoin here, so
                // the dollar value would buy btcUsd times too much
                usd: isBtcQuote ? round(sizeQuote, 8) : round(sizeUsd, 2),
                price: entry,
                quantity: round(sizeQuote / entry, 8),
                ...(isBtcQuote ? { quote: "BTC" } : {}),
              })
            : {
                ok: false,
                message:
                  spendable < floorQuote
                    ? `No spendable ${quoteAsset} on ${live.conn.label} to fund the order`
                    : `After the risk rules the order sits below ${trade.symbol}'s exchange minimum — raise risk per trade or the budget cap`,
              };
        if (!real.ok) {
          return Response.json({ error: `The exchange refused the order: ${real.message}` }, { status: 502 });
        }
      }

      // the rules this position is opened under, copied onto it: the live
      // desk's own set for a dollar book, the Bitcoin book's own set on a BTC
      // market — each book keeps its rules apart, so the copy must too
      const snapshotBook = trade.quote_asset === "BTC" ? "BTC" : "USD";
      const snapshotView =
        snapshotBook === "BTC"
          ? btcBookView(liveRulesView(config), (config && config.live_rules ? config.live_rules : {}).live_btc_rules)
          : liveRulesView(config);
      await base44.entities.Trade.update(tradeId, {
        status: "open",
        rules_snapshot: rulesSnapshot({ desk: "live", book: snapshotBook, view: snapshotView }),
        // the risk the position is opened with, measured from the fill to the
        // stop it carries: fixed here so its R divides by what it risked
        risk_pct: round(
          riskPctAt(real ? real.avg_price || trade.entry_price : trade.entry_price, trade.stop_price),
          2,
        ),
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
        await base44.entities.BotConfig.update(config.id, isBtcPaper
          ? { btc_cash_balance: round((Number(config.btc_cash_balance) || 0) - size) }
          : { cash_balance: round(cash - size) });
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
      // a desk scans its own venue's board, so a coin it trades can be one the
      // public board does not list — and a paper close must never be refused
      // for that. The position's own symbol and the rate are read from the live
      // feed as well, and the close only fails when neither source prices it.
      const isBtcQuote = trade.quote_asset === "BTC";
      const freshPx = await fetchLivePrices([String(trade.symbol || "").toUpperCase(), "BTC"]).catch(
        () => new Map(),
      );
      // a BTC-quoted position's own market is priced in bitcoin, so its exit
      // and its P&L are translated at the rate — a dollar price compared
      // with a BTC entry would book a nonsense result
      const btcUsd = Number(coins.find((c) => c.symbol === "BTC")?.price) || Number(freshPx.get("BTC")) || 0;
      const fx = isBtcQuote ? btcUsd : 1;
      if (!(fx > 0)) {
        return Response.json(
          { error: "No live Bitcoin price right now — the position was left open, try again in a moment" },
          { status: 502 },
        );
      }
      const priceUsd =
        Number(coins.find((c) => c.symbol === trade.symbol)?.price) ||
        Number(freshPx.get(String(trade.symbol || "").toUpperCase())) ||
        0;
      if (!(Number(priceUsd) > 0)) {
        return Response.json(
          { error: `No live price for ${trade.symbol} right now — the position was left open, try again in a moment` },
          { status: 502 },
        );
      }
      let closePrice = Number(priceUsd) / fx;
      let dustNote = "";
      // closing a real position sends a real sell order first, whichever way it
      // was opened or imported
      if (trade.mode === "real") {
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
      if (isPaper && config && isBtcQuote) {
        await base44.entities.BotConfig.update(config.id, { btc_cash_balance: round((Number(config.btc_cash_balance) || 0) + closed.size + closed.pnl) });
      }
      if (isPaper && config && !isBtcQuote) {
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