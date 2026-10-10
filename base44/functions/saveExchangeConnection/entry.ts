import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { EXCHANGES, readAccount } from '../../shared/exchanges.ts';
import { encryptSecret } from '../../shared/crypto.ts';

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
    const exchange = String(body.exchange || '');
    const meta = EXCHANGES[exchange];
    if (!meta) return Response.json({ error: 'Pick one of the supported exchanges' }, { status: 400 });

    const apiKey = String(body.api_key || '').trim();
    const apiSecret = String(body.api_secret || '').trim();
    const passphrase = String(body.passphrase || '').trim();
    if (!apiKey || !apiSecret) return Response.json({ error: 'Both the API key and the secret are required' }, { status: 400 });
    if (meta.needsPassphrase && !passphrase) {
      return Response.json({ error: 'KuCoin connections also need the API passphrase' }, { status: 400 });
    }
    const testnet = Boolean(body.testnet) && meta.testnet;
    const allowTrading = Boolean(body.allow_trading);

    const account = await readAccount({ exchange, testnet, api_key: apiKey, api_secret: apiSecret, passphrase });

    const patch = {
      exchange,
      api_key: apiKey,
      api_secret: await encryptSecret(apiSecret),
      passphrase: await encryptSecret(passphrase),
      label: (String(body.label || '').trim() || meta.name).slice(0, 60),
      testnet,
      allow_trading: allowTrading,
      status: account.ok ? 'connected' : 'error',
      status_message: account.message.slice(0, 300),
      can_trade: account.canTrade,
      key_hint: apiKey.length > 6 ? `••••${apiKey.slice(-4)}` : '••••',
      last_checked_at: new Date().toISOString(),
      balances: account.balances.slice(0, 10),
    };

    const existing = await base44.entities.ExchangeConnection.filter({ exchange }, { limit: 10 });
    const mine = (existing.items || []).find((c) => c.created_by_id === user.id) || null;
    const record = mine
      ? await base44.entities.ExchangeConnection.update(mine.id, patch)
      : await base44.entities.ExchangeConnection.create(patch);

    const safe = { id: record.id };
    for (const f of SAFE_FIELDS) safe[f] = record[f];
    return Response.json({
      connection: safe,
      account: { ok: account.ok, message: account.message, can_trade: account.canTrade, balances: account.balances.slice(0, 10) },
    });
  } catch (error) {
    return Response.json({ error: (error && error.message) || 'Could not save the connection' }, { status: 500 });
  }
}