import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import {
  readAccount,
  pickQuoteBalance,
  pickFundingQuote,
  isBackedOff,
} from "../../shared/exchanges.ts";
import { decryptSecret } from "../../shared/crypto.ts";
import { convertToUsdt } from "../../shared/orders.ts";
import { round } from "../../shared/market.ts";

// Kraken offers no fiat-to-fiat conversion through its API and no fiat/fiat
// market, but it lists USDT/fiat pairs — so non-USD cash (CAD, EUR, GBP) is
// swapped into USDT, which the bot then spends on USDT-settled pairs.

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body.action === "execute" ? "execute" : "quote";
    const conn = await base44.asServiceRole.entities.ExchangeConnection
      .get(String(body.id || ""))
      .catch(() => null);
    if (!conn || (conn.created_by_id !== user.id && user.role !== "admin"))
      return Response.json({ error: "Connection not found" }, { status: 404 });
    if (conn.exchange !== "kraken")
      return Response.json({ ok: false, message: "Fiat conversion is available on Kraken connections only" });
    if (isBackedOff(conn))
      return Response.json({ ok: false, message: `Kraken is paused until ${conn.backoff_until} after the last failed read — try again shortly` });

    const cfg = {
      exchange: conn.exchange,
      testnet: Boolean(conn.testnet),
      api_key: await decryptSecret(conn.api_key),
      api_secret: await decryptSecret(conn.api_secret),
      passphrase: await decryptSecret(conn.passphrase || ""),
    };

    // fresh balances: the saved list may be stale, and the cash may already
    // have moved
    const acct = await readAccount(cfg);
    if (!acct.ok) return Response.json({ ok: false, message: acct.message });
    const balances = acct.balances || [];
    const funding = pickFundingQuote(balances, "kraken");
    if (funding && funding.amount >= 10) {
      await saveBalance(base44, conn, acct, balances);
      return Response.json({
        ok: false,
        message: `This account already holds ${round(funding.amount, 2)} ${funding.asset} — the bot can trade with it as-is.`,
      });
    }
    const fiat = balances
      .filter((b) => ["CAD", "EUR", "GBP"].includes(b.asset) && (Number(b.total) || 0) >= 1)
      .sort((a, b) => b.total - a.total)[0];
    if (!fiat)
      return Response.json({
        ok: false,
        message: "No convertible cash balance (CAD, EUR or GBP) found on this account.",
      });

    if (action === "quote") {
      return Response.json({
        ok: true,
        available: round(fiat.total, 2),
        currency: fiat.asset,
        next_action: "execute",
      });
    }

    const res = await convertToUsdt(cfg, { amount: fiat.total, currency: fiat.asset });
    // refresh the saved balances either way so the card shows the new state
    const after = await readAccount(cfg);
    if (after.ok) await saveBalance(base44, conn, after, after.balances);
    return Response.json({ ...res, balances: after.ok ? after.balances : balances });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

async function saveBalance(base44, conn, acct, balances) {
  const usd = await pickQuoteBalance(balances, "kraken");
  await base44.asServiceRole.entities.ExchangeConnection.update(conn.id, {
    status: "connected",
    status_message: acct.message,
    balances: balances.slice(0, 10),
    balance_usd: usd,
    balance_updated_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    backoff_until: null,
  });
}