// Rule-lock guardrails: when a desk's own bot rules reject every setup the
// scan produces, these helpers name the gates doing the rejecting and warn —
// instead of the desk silently sitting on its capital.
import { asArray } from "./market.ts";
export { gateReason } from "./entryRules.ts";

/**
 * Per-desk diagnostics: a desk with open slots that took nothing while
 * candidates were on the board is being locked out by its own rules —
 * record which gates did the rejecting. Returns { [desk]: [[reason, count]] }.
 */
export function collectGateLocks(rows, gate, opts) {
  const diag = {};
  for (const desk of opts.desks) {
    if ((opts.slots[desk] ?? 0) <= 0) continue;
    if ((opts.taken[desk] ?? 0) > 0) continue;
    const blocked = opts.blocked[desk] || new Set();
    const counts = {};
    let considered = 0;
    for (const r of rows) {
      if (blocked.has(r.symbol)) continue;
      considered += 1;
      const reason = gate(r, desk);
      if (reason) counts[reason] = (counts[reason] || 0) + 1;
    }
    if (considered && Object.keys(counts).length)
      diag[desk] = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
  }
  return diag;
}

/**
 * Throttled warning alerts: one per desk per 6 hours, so rules that fail
 * silently become visible in the bell instead of a desk trading nothing.
 */
export async function raiseGateLockAlerts(base44, diag, ownerId) {
  if (!diag || !Object.keys(diag).length) return;
  const recent = asArray(
    await base44.entities.Alert.filter(
      {
        created_by_id: ownerId,
        kind: "rule_warning",
        created_date: { $gte: new Date(Date.now() - 6 * 3600 * 1000).toISOString() },
      },
      { limit: 5 },
    ),
  );
  const warned = new Set(recent.map((a) => a.symbol));
  for (const [desk, top] of Object.entries(diag)) {
    if (!top || !top.length || warned.has(desk)) continue;
    const list = top.map(([reason, n]) => `${reason} (${n})`).join(", ");
    await base44.entities.Alert.create({
      symbol: desk,
      title:
        desk === "live"
          ? "Live rules are keeping the desk from filling"
          : "Paper rules are keeping the desk from filling",
      message: `${top[0][1]} setups scanned but every one was rejected by the desk's own rules: ${list}. Loosen the matching rule under bot rules if more fills are wanted.`,
      mode: desk === "live" ? "live" : "paper",
      kind: "rule_warning",
      severity: "warning",
    });
  }
}