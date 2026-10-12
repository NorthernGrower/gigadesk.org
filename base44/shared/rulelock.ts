// Rule-lock guardrails: when a desk's own bot rules reject every setup the
// scan produces, these helpers name the gates doing the rejecting and warn —
// instead of the desk silently sitting on its capital.
import { asArray } from "./market.ts";

/**
 * The same gate chain the bot's qualify() applies, but it names the FIRST
 * failing gate. `rules` carries the desk's resolved values:
 * { min_score, allow_shorts, engine_v2, champion, btc_regime,
 *   require_target, target_pct }
 */
export function gateReason(r, desk, rules) {
  if ((Number(r.score) || 0) < (Number(rules.min_score) || 0)) return "score under the minimum";
  const shortBlocked =
    desk === "live" ? r.side !== "long" : rules.allow_shorts === false && r.side !== "long";
  if (shortBlocked)
    return desk === "live" ? "short setup (real orders take longs only)" : "shorts are switched off";
  if (rules.engine_v2 !== false) {
    if (rules.champion !== false && r.side === "long" && rules.btc_regime !== "risk_off")
      return "long gated: BTC tape not risk-off";
    if (!r.htf_trend || r.htf_trend !== (r.side === "long" ? "up" : "down"))
      return "higher timeframe disagrees";
    const ind = r.indicators || {};
    if ((Number(ind.adx) || 0) < 25) return "ADX under 25";
    const diOwned =
      r.side === "long"
        ? (Number(ind.plus_di) || 0) > (Number(ind.minus_di) || 0)
        : (Number(ind.minus_di) || 0) > (Number(ind.plus_di) || 0);
    if (!diOwned) return "DI pair not owned";
    if ((r.confluence || 0) < 3) return "under 3 confluences";
    if ((Number(ind.vol_ratio) || 0) < (rules.champion !== false ? 1.5 : 1.2))
      return "volume under the required multiple";
    if (ind.ema20) {
      const stretch = ((r.price - ind.ema20) / ind.ema20) * 100 * (r.side === "long" ? 1 : -1);
      if (stretch > 5) return "stretch over 5%";
    }
    if (r.fib_phase === "chasing") return "entry is chasing";
  }
  if (rules.require_target) {
    if (rules.champion !== false && rules.engine_v2 !== false) {
      const stopPct = (Math.abs(r.entry - r.stop) / r.entry) * 100;
      if (2.5 * stopPct < (Number(rules.target_pct) || 0))
        return `2.5R move under the ${rules.target_pct}% target`;
    } else if (Number(r.required_move_pct) < (Number(rules.target_pct) || 0)) {
      return `required move under the ${rules.target_pct}% target`;
    }
  }
  return null;
}

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