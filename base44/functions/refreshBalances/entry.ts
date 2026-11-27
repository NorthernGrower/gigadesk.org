import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { readAccount, accountValueUsd, isBackedOff, backoffUntil, balanceJustRead, keepBalances } from '../../shared/exchanges.ts';
import { decryptSecret } from '../../shared/crypto.ts';
import { syncExchangePositions } from '../../shared/reconcile.ts';
import { asArray } from '../../shared/market.ts';
import { liveRule } from '../../shared/deskRules.ts';

// Refreshes every connected exchange's quote balance and stores it on the
// connection, so the desk always has a saved balance to show even when a
// later live read fails. Runs on a schedule.

// The schedule fires every 10 minutes. One run per window keeps a repeated hit
// on this public URL from firing signed calls into every user's exchange again.
const RUN_KEY = "balance_refresh";
const RUN_COOLDOWN_MS = 8 * 60 * 1000;

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    // Admin-only: the run decrypts and spends every user's stored exchange
    // credentials. The scheduled workflows call this as their creator (an app
    // admin), and anyone else — signed in or not — is refused before any work.
    const user = await base44.auth
      .me()
      .catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // a scheduled workflow has no signed-in admin: a workflow step runs as the
    // app, so a service account passes the same check an admin does. An
    // ordinary user never does, and a signed-out caller never gets this far.
    if (user.role !== "admin" && user.is_service !== true)
      return Response.json({ error: "Forbidden" }, { status: 403 });

    // single run per cooldown window, whoever calls: the scheduler and an
    // on-demand refresh never double up, and repeated anonymous hits reuse the
    // last run instead of burning every user's exchange rate budget
    const lastRun = asArray(
      await base44.asServiceRole.entities.MarketCache.filter({ key: RUN_KEY }, { limit: 1 }),
    )[0];
    const lastAt = Number((lastRun && lastRun.value && lastRun.value.at) || 0);
    if (Date.now() - lastAt < RUN_COOLDOWN_MS)
      return Response.json({ checked: 0, skipped: "recent_run" });
    await base44.asServiceRole.entities.MarketCache
      .upsert([{ key: RUN_KEY, value: { at: Date.now() } }], { key: "key" })
      .catch(() => {});

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

    // a connection in backoff still gets a live balance: its saved holdings
    // are repriced from public tickers (no keys involved, so a lockout cannot
    // touch them) — the next signed read verifies the figure once backoff
    // clears. Quantities only refresh when the signed read resumes.
    const backedOff = (conns || []).filter(
      (c) => c.api_key && isBackedOff(c) && Array.isArray(c.balances) && c.balances.length,
    );
    for (const conn of backedOff) {
      try {
        const balance = await accountValueUsd(
          { exchange: conn.exchange, testnet: Boolean(conn.testnet) },
          conn.balances,
          { skipSigned: true },
        );
        if (balance > 0) {
          await base44.asServiceRole.entities.ExchangeConnection.update(conn.id, { balance_usd: balance });
        }
      } catch (e) {
        console.log("public reprice failed for connection " + conn.id + ": " + (e && e.message));
      }
    }

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
            // the Bitcoin row always survives the cap: it is the funding the
            // BTC market book spends, and a holding with a tiny unit count
            // must never be dropped for being small
            balances: keepBalances(account.balances),
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
              stopPct: rules ? Number(liveRule(rules.live_rules, "default_stop_pct", 2.5)) : undefined,
              targetR: rules && (liveRule(rules.live_rules, "engine_v2", true)) !== false && (liveRule(rules.live_rules, "champion_engine", true)) !== false ? 2.5 : 0,
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

    // each result carries a connection's label, exchange message and balance
    // figures for OTHER users' accounts — only an authenticated admin reaches
    // this point, so every caller here may see them
    return Response.json({ checked: usable.length, results });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}