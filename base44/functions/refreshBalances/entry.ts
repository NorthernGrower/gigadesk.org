import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { readAccount, accountValueUsd, isBackedOff, backoffUntil, balanceJustRead } from '../../shared/exchanges.ts';
import { decryptSecret } from '../../shared/crypto.ts';
import { syncExchangePositions } from '../../shared/reconcile.ts';
import { asArray } from '../../shared/market.ts';

// Refreshes every connected exchange's quote balance and stores it on the
// connection, so the desk always has a saved balance to show even when a
// later live read fails. Runs on a one-minute schedule.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const conns = await base44.asServiceRole.entities.ExchangeConnection.filter({});
    // a connection in backoff is left alone: its key failed a signed read
    // recently and retrying keeps the exchange-side lockout alive. Errored
    // connections that had worked before (a saved balance) are retried once
    // their backoff expires, so a temporary lockout self-heals instead of
    // leaving the desk dark until a manual check.
    const usable = (conns || []).filter(
      (c) => c.api_key && !isBackedOff(c) && !balanceJustRead(c) && (c.status === 'connected' || c.balance_updated_at != null),
    );
    // per-owner bot rules, so imported positions carry the desk's own risk
    // levels (stop and target)
    const configs = asArray(
      await base44.asServiceRole.entities.BotConfig.filter({}, { sort: '-updated_date', limit: 50 }),
    );
    const rulesByOwner = new Map();
    for (const c of configs)
      if (!rulesByOwner.has(c.created_by_id)) rulesByOwner.set(c.created_by_id, c);

    const results = [];
    for (let i = 0; i < usable.length; i += 6) {
      const batch = usable.slice(i, i + 6);
      const settled = await Promise.allSettled(
        batch.map(async (conn) => {
          const cfg = {
            exchange: conn.exchange,
            testnet: Boolean(conn.testnet),
            api_key: await decryptSecret(conn.api_key),
            api_secret: await decryptSecret(conn.api_secret),
            passphrase: await decryptSecret(conn.passphrase || ''),
          };
          const account = await readAccount(cfg);
          if (!account.ok) {
            // back the key off instead of retrying it next cycle: a lockout
            // needs silence to clear, so the saver pauses on this connection
            await base44.asServiceRole.entities.ExchangeConnection.update(conn.id, {
              backoff_until: backoffUntil(account.message),
            });
            return { id: conn.id, label: conn.label, ok: false, message: account.message };
          }
          // total account value (every holding priced), so the desk matches
          // what the exchange app shows — sizing still reads the cash in
          // `balances`, never this figure
          const balance = await accountValueUsd(cfg, account.balances);
          await base44.asServiceRole.entities.ExchangeConnection.update(conn.id, {
            status: 'connected',
            status_message: account.message,
            balance_usd: balance,
            balance_updated_at: new Date().toISOString(),
            balances: account.balances.slice(0, 10),
            last_checked_at: new Date().toISOString(),
            backoff_until: null,
          });
          // wallet sync: reconcile the desk's open real positions with what
          // this exchange actually holds — imports untracked holdings, closes
          // sold ones. Runs here so the sync also happens while the app is
          // closed, not only inside bot cycles.
          let wallet_sync = null;
          try {
            const rules = rulesByOwner.get(conn.created_by_id) || null;
            wallet_sync = await syncExchangePositions(
              base44,
              { ...cfg, label: conn.label, id: conn.id, fills_fetched_at: conn.fills_fetched_at },
              account.balances,
              {
              ownerId: conn.created_by_id,
              stopPct: rules ? (rules.live_rules?.default_stop_pct ?? rules.default_stop_pct) : undefined,
              targetR: rules && rules.engine_v2 !== false && rules.champion_engine !== false ? 2.5 : 0,
            });
          } catch (e) {
            wallet_sync = { reason: (e && e.message) || 'sync failed' };
          }
          return { id: conn.id, label: conn.label, ok: true, balance, wallet_sync };
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