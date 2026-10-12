import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { readAccount } from '../../shared/exchanges.ts';
import { decryptSecret } from '../../shared/crypto.ts';
import { QUOTE_ASSET } from '../../shared/orders.ts';
import { round } from '../../shared/market.ts';

// Refreshes every connected exchange's quote balance and stores it on the
// connection, so the desk always has a saved balance to show even when a
// later live read fails. Runs on a one-minute schedule.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const conns = await base44.asServiceRole.entities.ExchangeConnection.filter({ status: 'connected' });
    const usable = (conns || []).filter((c) => c.api_key);

    const results = [];
    for (let i = 0; i < usable.length; i += 6) {
      const batch = usable.slice(i, i + 6);
      const settled = await Promise.allSettled(
        batch.map(async (conn) => {
          const account = await readAccount({
            exchange: conn.exchange,
            testnet: Boolean(conn.testnet),
            api_key: await decryptSecret(conn.api_key),
            api_secret: await decryptSecret(conn.api_secret),
            passphrase: await decryptSecret(conn.passphrase || ''),
          });
          if (!account.ok) return { id: conn.id, label: conn.label, ok: false, message: account.message };
          const quote = QUOTE_ASSET[conn.exchange] || 'USDT';
          const row = (account.balances || []).find((b) => b.asset === quote);
          const balance = row ? round(Number(row.total) || 0, 2) : 0;
          await base44.asServiceRole.entities.ExchangeConnection.update(conn.id, {
            balance_usd: balance,
            balance_updated_at: new Date().toISOString(),
            balances: account.balances.slice(0, 10),
            last_checked_at: new Date().toISOString(),
          });
          return { id: conn.id, label: conn.label, ok: true, balance };
        }),
      );
      for (const r of settled) {
        results.push(r.status === 'fulfilled' ? r.value : { ok: false, message: r.reason?.message || 'failed' });
      }
    }

    return Response.json({ checked: usable.length, results });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}