import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { readAccount } from '../../shared/exchanges.ts';

const SAFE_FIELDS = [
  "exchange",
  "label",
  "key_hint",
  "testnet",
  "allow_trading",
  "status",
  "status_message",
  "can_trade",
  "last_checked_at",
  "balances",
];

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const id = String(body.id || '');
    if (!id) return Response.json({ error: 'Missing connection id' }, { status: 400 });

    const conn = await base44.entities.ExchangeConnection.get(id);
    if (!conn) return Response.json({ error: 'Connection not found' }, { status: 404 });

    const account = await readAccount({
      exchange: conn.exchange,
      testnet: Boolean(conn.testnet),
      api_key: conn.api_key,
      api_secret: conn.api_secret,
      passphrase: conn.passphrase || '',
    });

    const patch = {
      status: account.ok ? 'connected' : 'error',
      status_message: account.message.slice(0, 300),
      can_trade: account.canTrade,
      last_checked_at: new Date().toISOString(),
      balances: account.balances.slice(0, 10),
    };
    await base44.entities.ExchangeConnection.update(id, patch);

    const merged = { ...conn, ...patch };
    const safe = { id };
    for (const f of SAFE_FIELDS) safe[f] = merged[f];
    return Response.json({
      connection: safe,
      account: { ok: account.ok, message: account.message, balances: account.balances.slice(0, 10) },
    });
  } catch (error) {
    return Response.json({ error: (error && error.message) || 'Could not check the connection' }, { status: 500 });
  }
}