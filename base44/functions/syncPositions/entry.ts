import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { resolveLiveConnection } from "../../shared/orders.ts";
import { syncExchangePositions } from "../../shared/reconcile.ts";
import { readAccount, isBackedOff } from "../../shared/exchanges.ts";
import { asArray } from "../../shared/market.ts";

// On-demand wallet sync: reads the connected exchange's wallet and reconciles
// the live desk's positions with it (imports untracked holdings, closes sold
// ones). Also runs automatically on every bot cycle and balance refresh.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const config = asArray(
      await base44.entities.BotConfig.filter({}, { sort: "-updated_date", limit: 1 }),
    )[0];
    if (!config) return Response.json({ error: "Save bot rules first" }, { status: 400 });

    const managed = await resolveLiveConnection(base44, config, { manage: true, readOnly: true });
    if (!managed.conn)
      return Response.json({ error: managed.reason || "No exchange connection" }, { status: 400 });

    // a fresh wallet read unless the key is locked out; otherwise the last
    // saved balance list
    let balances = null;
    if (!isBackedOff(managed.conn)) {
      const acct = await readAccount({
        exchange: managed.conn.exchange,
        testnet: managed.conn.testnet,
        api_key: managed.conn.api_key,
        api_secret: managed.conn.api_secret,
        passphrase: managed.conn.passphrase || "",
      });
      if (acct.ok) balances = acct.balances;
    }
    if (!balances || !balances.length) {
      const stored = await base44.asServiceRole.entities.ExchangeConnection
        .get(managed.conn.id)
        .catch(() => null);
      balances = stored && Array.isArray(stored.balances) ? stored.balances : null;
    }
    if (!balances || !balances.length)
      return Response.json({ error: "Could not read the wallet right now" }, { status: 502 });

    const result = await syncExchangePositions(base44, managed.conn, balances, {
      ownerId: config.created_by_id || user.id,
      stopPct: config.live_rules?.default_stop_pct ?? config.default_stop_pct,
      targetR: config.engine_v2 !== false && config.champion_engine !== false ? 2.5 : 0,
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}