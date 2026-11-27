// Bitcoin dominance, as the desk can read it: Bitcoin's share of the market
// caps on the board, and which way that share moved over the last day. It is
// the axis the alts trade on — money leaving Bitcoin is money arriving in
// them, and money going back to Bitcoin leaves them — so the bot uses it as a
// weight on a setup's score and never as a signal of its own.
//
// One snapshot says nothing about direction, so a reading is kept on the desk
// (a MarketCache row) each cycle and the change is measured against the
// reading closest to 24 hours ago. Without an old enough reading the change is
// unknown and no weight is applied, rather than a direction being invented.
import { asArray, round } from "./market.ts";

export const DOMINANCE = {
  // the points a setup gains or loses: one fixed amount either way, as the
  // harmonic weight is, so one market fact can never swamp the setup's score
  points: 5,
  // a reading every 15 minutes is plenty — the share moves by tenths of a
  // point a day, and a reading per cycle would rewrite the cache row each time
  sampleMs: 15 * 60 * 1000,
  // three days of readings answer a 24h change even after a quiet weekend
  keepMs: 3 * 24 * 3600 * 1000,
  // the window the change is measured over, and how far off a reading may sit
  windowMs: 24 * 3600 * 1000,
  toleranceMs: 6 * 3600 * 1000,
  // under this many priced coins the share is not a share of anything, which
  // is what a venue feed without market caps answers
  minCoins: 20,
};

/**
 * Bitcoin's share of the market caps on the board, in percent. Null when the
 * board carries too few caps to mean anything: a venue's own ticker has no
 * market caps at all, so the desk reads null there instead of a share built
 * from one coin.
 */
export function dominanceShare(coins) {
  let btcCap = 0;
  let total = 0;
  let counted = 0;
  for (const c of coins || []) {
    const cap = Number(c && c.market_cap) || 0;
    if (!(cap > 0)) continue;
    total += cap;
    counted += 1;
    if (String(c.symbol || "").toUpperCase() === "BTC") btcCap = cap;
  }
  if (counted < DOMINANCE.minCoins || !(btcCap > 0) || !(total > 0)) return null;
  return (btcCap / total) * 100;
}

/**
 * The 24h change in Bitcoin's share, in percentage points: negative means the
 * share fell, which is the tape the alts travel better in. Null when no saved
 * reading sits near a day ago — an invented direction is worse than none.
 */
export function dominanceChange(samples, nowMs = Date.now()) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const target = nowMs - DOMINANCE.windowMs;
  let past = null;
  let latest = null;
  for (const s of samples) {
    const pct = Number(s && s.pct);
    const at = Date.parse(s && s.at);
    if (!Number.isFinite(pct) || !Number.isFinite(at)) continue;
    latest = s;
    const age = nowMs - at;
    // a reading has to sit roughly a day back, and only the closest one counts
    if (Math.abs(age - DOMINANCE.windowMs) > DOMINANCE.toleranceMs) continue;
    if (!past || Math.abs(at - target) < Math.abs(Date.parse(past.at) - target)) past = s;
  }
  if (!past || !latest || latest.at === past.at) return null;
  return Number(latest.pct) - Number(past.pct);
}

/**
 * The score a long carries for that change: an alt gains while Bitcoin's share
 * falls and loses while it climbs, by the same fixed amount. 0 when the change
 * is unknown or flat, which leaves the score exactly as the scan built it.
 */
export function dominancePoints(change) {
  const d = Number(change);
  if (!Number.isFinite(d) || d === 0) return 0;
  return d < 0 ? DOMINANCE.points : -DOMINANCE.points;
}

/**
 * This cycle's reading: the share, its 24h change and the points a long should
 * carry. The share is saved for later cycles when a db client is passed, so a
 * direction can be measured at all; a failed write costs the next comparison,
 * never this cycle's entry.
 */
export async function readDominance(db, coins) {
  const nowMs = Date.now();
  const share = dominanceShare(coins);
  let samples = [];
  if (db) {
    try {
      const rows = asArray(
        await db.entities.MarketCache.filter({ key: "dominance" }, { limit: 1 }),
      );
      const saved = rows[0] && rows[0].value;
      if (saved && Array.isArray(saved.samples)) samples = saved.samples;
    } catch {
      // the reading is an extra, never a reason to fail a cycle
      samples = [];
    }
  }
  const change = dominanceChange(samples, nowMs);
  const newest = samples.length ? Date.parse(samples[samples.length - 1] && samples[samples.length - 1].at) : 0;
  if (share != null && db && (!(newest > 0) || nowMs - newest >= DOMINANCE.sampleMs)) {
    const next = [...samples, { at: new Date(nowMs).toISOString(), pct: round(share, 2) }]
      .filter((s) => {
        const at = Date.parse(s && s.at);
        return Number.isFinite(at) && nowMs - at <= DOMINANCE.keepMs;
      });
    try {
      await db.entities.MarketCache.upsert(
        [
          {
            key: "dominance",
            value: { samples: next, saved_at: new Date(nowMs).toISOString() },
          },
        ],
        { key: "key" },
      );
    } catch (err) {
      console.log(`dominance reading save failed: ${err && err.message}`);
    }
  }
  return {
    pct: share == null ? null : round(share, 2),
    change_24h: change == null ? null : round(change, 2),
    points: dominancePoints(change),
    samples: samples.length,
  };
}
