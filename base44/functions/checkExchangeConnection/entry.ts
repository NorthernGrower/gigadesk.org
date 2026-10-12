import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { readAccount, pickQuoteBalance, backoffUntil, isBackedOff } from '../../shared/exchanges.ts';
import { encryptSecret, decryptSecret } from '../../shared/crypto.ts';

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
  "backoff_until",
  "balances",
  "balance_usd",
  "balance_updated_at",
];

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const id = String(body.id || '');
    if (!id) return Response.json({ error: 'Missing connection id' }, { status: 400 });

    // credential fields are hidden from every client-side read, so this read
    // goes through the service role — with an owner check, since the row
    // rules no longer apply here
    const conn = await base44.asServiceRole.entities.ExchangeConnection.get(id);
    if (!conn || conn.created_by_id !== user.id) {
      return Response.json({ error: 'Connection not found' }, { status: 404 });
    }

    // a key in backoff is left alone: every retry during the pause counts
    // toward the exchange-side lockout and keeps it alive. The saved balance
    // and status travel back unchanged instead. A manual verify (force) is
    // the user's own click and may proceed.
    if (isBackedOff(conn) && body.force !== true) {
      const safePaused = { id };
      for (const f of SAFE_FIELDS) safePaused[f] = conn[f];
      return Response.json({
        connection: safePaused,
        account: { ok: false, message: conn.status_message || 'Paused after a failed read', balances: [] },
        paused: true,
      });
    }

    const apiKey = await decryptSecret(conn.api_key || '');
    const account = await readAccount({
      exchange: conn.exchange,
      testnet: Boolean(conn.testnet),
      api_key: apiKey,
      api_secret: await decryptSecret(conn.api_secret),
      passphrase: await decryptSecret(conn.passphrase || ''),
    });

    const patch = {
      // upgrade credentials stored before encryption existed (legacy rows)
      ...(String(conn.api_key || '').startsWith('enc1:') && String(conn.api_secret || '').startsWith('enc1:')
        ? {}
        : {
            api_key: await encryptSecret(apiKey),
            api_secret: await encryptSecret(await decryptSecret(conn.api_secret || '')),
            ...(conn.passphrase && !String(conn.passphrase).startsWith('enc1:')
              ? { passphrase: await encryptSecret(await decryptSecret(conn.passphrase)) }
              : {}),
          }),
      status: account.ok ? 'connected' : 'error',
      status_message: account.message.slice(0, 300),
      can_trade: account.canTrade,
      last_checked_at: new Date().toISOString(),
      balances: account.balances.slice(0, 10),
      // save the fresh balance so the desk keeps a figure when a later
      // read fails; a failed read backs the key off so the saver and the
      // desk stop retrying it into a longer exchange-side lockout
      ...(account.ok
        ? {
            balance_usd: await pickQuoteBalance(account.balances, conn.exchange),
            balance_updated_at: new Date().toISOString(),
            backoff_until: null,
          }
        : {
            backoff_until: backoffUntil(account.message),
          }),
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