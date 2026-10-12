// Temporary one-off: sells base holdings stranded by a real position the app
// already considers closed (its close was refused because fees were taken in
// the base asset), so the money returns to the spendable quote balance.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { placeMarketOrder } from "../../shared/orders.ts";
import { readAccount } from "../../shared/exchanges.ts";
import { decryptSecret } from "../../shared/crypto.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const tradeId = String(body.trade_id || "");
    const trade = await base44.asServiceRole.entities.Trade.get(tradeId).catch(() => null);
    if (!trade) return Response.json({ error: "Trade not found" }, { status: 404 });
    if ((trade.mode || "paper") !== "real" || !trade.exchange_order_id)
      return Response.json({ error: "Not a bot-placed real position" }, { status: 400 });

    const conns = await base44.asServiceRole.entities.ExchangeConnection.filter(
      { created_by_id: trade.created_by_id, exchange: trade.exchange, status: "connected" },
      { limit: 2 },
    );
    const list = Array.isArray(conns) ? conns : conns.items || [];
    if (!list.length) return Response.json({ error: "No connected exchange account" }, { status: 409 });
    const c = list[0];
    const cfg = {
      exchange: c.exchange,
      label: c.label,
      testnet: Boolean(c.testnet),
      api_key: await decryptSecret(c.api_key),
      api_secret: await decryptSecret(c.api_secret),
      passphrase: await decryptSecret(c.passphrase || ""),
    };

    const acct = await readAccount(cfg);
    const held = acct.ok ? (acct.balances || []).find((b) => b.asset === String(trade.symbol).toUpperCase()) : null;
    const total = held ? Number(held.total) || 0 : 0;
    if (!(total > 0))
      return Response.json({ ok: false, message: `No ${trade.symbol} left on the account` });

    const sell = await placeMarketOrder(cfg, { symbol: trade.symbol, side: "sell", quantity: total });
    if (!sell.ok) return Response.json({ ok: false, message: sell.message }, { status: 502 });

    const after = await readAccount(cfg);
    const usd = after.ok ? (after.balances || []).find((b) => b.asset === "USD") : null;
    await base44.asServiceRole.entities.Trade.update(trade.id, {
      notes: `Stranded ${total} ${trade.symbol} sold back at market — proceeds returned to the spendable USD balance.`,
    });
    return Response.json({
      ok: true,
      order_id: sell.order_id,
      sold: sell.filled_qty,
      usd_after: usd ? Number(usd.total) : null,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}