import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, asArray, round } from "../../shared/market.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const tradeId = String(body.trade_id || "");
    if (!tradeId) return Response.json({ error: "A trade id is required" }, { status: 400 });

    const trade = await base44.entities.Trade.get(tradeId);
    if (!trade) return Response.json({ error: "Trade not found" }, { status: 404 });

    const config = asArray(await base44.entities.BotConfig.filter({}, { limit: 1 }))[0];
    const cash = Number(config?.cash_balance) || 0;
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
      await base44.entities.Trade.update(tradeId, {
        status: "open",
        size_usd: round(size),
        quantity: round(qty, 8),
        opened_at: new Date().toISOString(),
      });
      if (isPaper && config) {
        await base44.entities.BotConfig.update(config.id, { cash_balance: round(cash - size) });
      }
      return Response.json({ ok: true, status: "open", cash: round(isPaper ? cash - size : cash) });
    }

    if (action === "reject") {
      await base44.entities.Trade.update(tradeId, { status: "rejected" });
      return Response.json({ ok: true, status: "rejected" });
    }

    if (action === "close") {
      if (trade.status !== "open") {
        return Response.json({ error: "Only an open position can be closed" }, { status: 409 });
      }
      const { coins } = await fetchMarkets();
      const price = coins.find((c) => c.symbol === trade.symbol)?.price;
      if (!price) {
        return Response.json({ error: "No live price for this coin right now" }, { status: 502 });
      }
      const entry = Number(trade.entry_price) || 0;
      const qty = Number(trade.quantity) || 0;
      const size = Number(trade.size_usd) || 0;
      const pnl = trade.side === "short" ? (entry - price) * qty : (price - entry) * qty;
      const pnlPct = size ? (pnl / size) * 100 : 0;

      await base44.entities.Trade.update(tradeId, {
        status: "closed",
        exit_price: round(price, 6),
        pnl_usd: round(pnl),
        pnl_pct: round(pnlPct),
        closed_at: new Date().toISOString(),
        exit_reason: "manual",
      });
      if (isPaper && config) {
        await base44.entities.BotConfig.update(config.id, {
          cash_balance: round(cash + size + pnl),
        });
      }
      await base44.entities.Alert.create({
        symbol: trade.symbol,
        title: `${trade.symbol} closed manually`,
        message: `Exit ${round(price, 6)} — P&L ${round(pnl)} USD (${round(pnlPct)}%).`,
        kind: pnl >= 0 ? "target_hit" : "stop_hit",
        severity: pnl >= 0 ? "success" : "danger",
        trade_id: tradeId,
      });
      return Response.json({
        ok: true,
        status: "closed",
        exit_price: round(price, 6),
        pnl_usd: round(pnl),
        pnl_pct: round(pnlPct),
        cash: round(isPaper ? cash + size + pnl : cash),
      });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}