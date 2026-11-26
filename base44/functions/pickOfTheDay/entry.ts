import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchCandles, asArray } from "../../shared/market.ts";

// One public setup, chosen from the day's top 10 desk picks, for the landing
// page ad. The choice is anchored to the UTC day, so every visitor sees the
// same call and it rotates by itself every 24 hours. The payload carries what
// the desk's own call card shows — candles, the indicator snapshot and a full
// AI read with levels — so the homepage card can mirror the real thing.
//
// Public on purpose: the homepage has to render for signed-out visitors. What
// that means for a public endpoint, and what it therefore must not do:
//  - it reads only the app's own scan results (signals), never a person's
//    positions, rules or exchange account, so there is nothing personal here;
//  - the paid model call is limited to one a day, claimed on the app before it
//    is made, so reloading the homepage can no longer drive the bill;
//  - the only write is that cached read on the signal it belongs to.
const AI_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["strong_long", "long", "watch", "short", "strong_short", "avoid"],
    },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    thesis: { type: "string" },
    entry: { type: "number" },
    target: { type: "number" },
    stop: { type: "number" },
    setup_quality: { type: "string" },
    invalidation: { type: "string" },
    horizon: { type: "string" },
    risks: { type: "string" },
  },
  required: ["verdict", "confidence", "thesis", "risks"],
};

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);

    const page = await base44.asServiceRole.entities.Signal.filter(
      { status: "new" },
      { sort: "-score", limit: 100 },
    );
    const rows = page.items || [];
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const fresh = rows.filter((s) => s.detected_at && Date.parse(s.detected_at) >= cutoff);
    const top10 = (fresh.length ? fresh : rows).slice(0, 10);
    if (!top10.length) return Response.json({ day: new Date().toISOString().slice(0, 10), pick: null });

    const dayIndex = Math.floor(Date.now() / 86400000) % top10.length;
    const pick = top10[dayIndex];

    // the AI read is generated once and cached on the signal record, so a
    // whole day of visitors reuses one call instead of paying for each visit
    let ai = pick.indicators?.ai_featured || null;
    if (!ai) {
      // and only one paid call a day, whoever calls: the day's slot is claimed
      // on the app before the model is invoked, then re-read to confirm the
      // claim stuck, so a burst of visitors at the same moment still produces
      // exactly one call — an anonymous caller can no longer drive the bill by
      // reloading the homepage
      const slotKey = `featured_ai:${new Date().toISOString().slice(0, 10)}`;
      const slot = asArray(
        await base44.asServiceRole.entities.MarketCache.filter({ key: slotKey }, { limit: 1 }),
      )[0];
      if (!slot) {
        const claim = Date.now();
        await base44.asServiceRole.entities.MarketCache
          .upsert([{ key: slotKey, value: { at: claim, symbol: pick.symbol } }], { key: 'key' })
          .catch(() => {});
        const fresh = asArray(
          await base44.asServiceRole.entities.MarketCache.filter({ key: slotKey }, { limit: 1 }).catch(() => []),
        )[0];
        if (fresh && Number((fresh.value || {}).at) === claim) {
          ai = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `You are a crypto desk analyst writing a short public promo read on one setup for a trading platform's homepage.

Coin: ${pick.name || pick.symbol} (${pick.symbol})
Side: ${pick.side} | price ${pick.price} USD | entry ${pick.entry} | target ${pick.target} | stop ${pick.stop} | required move ${pick.required_move_pct}% | risk/reward ${pick.risk_reward} | score ${pick.score}/100 (${pick.grade})
Desk reasons: ${(pick.reasons || []).join("; ")}

Write a punchy but honest thesis (max 55 words) on why this setup stands out today, and the main risks (max 35 words). Judge the direction, refine the entry, target and stop if the numbers above are off, say what would invalidate the setup and the horizon it plays out over, and grade its setup quality. Never promise a return and never invent data beyond what is given.`,
            response_json_schema: AI_SCHEMA,
          }).catch(() => null);
          if (ai) {
            await base44.asServiceRole.entities.Signal.update(pick.id, {
              indicators: { ...(pick.indicators || {}), ai_featured: ai },
            }).catch(() => {});
          }
        }
      }
    }

    // the chart behind the call, from the public US feed — the homepage card
    // is public, so it never depends on anyone's exchange connection
    const candles = await fetchCandles(pick.symbol, pick.timeframe, 150).catch(() => null);

    return Response.json({
      day: new Date().toISOString().slice(0, 10),
      pool: top10.length,
      pick: {
        symbol: pick.symbol,
        name: pick.name,
        side: pick.side,
        timeframe: pick.timeframe,
        price: pick.price,
        score: pick.score,
        grade: pick.grade,
        verdict: pick.verdict,
        confidence: pick.confidence,
        market_cap_bucket: pick.market_cap_bucket,
        quality: pick.quality || null,
        confluence: pick.confluence ?? null,
        categories: pick.categories || null,
        indicators: pick.indicators || null,
        entry: pick.entry,
        target: pick.target,
        stop: pick.stop,
        required_move_pct: pick.required_move_pct,
        risk_reward: pick.risk_reward,
        reasons: pick.reasons || [],
        candles: Array.isArray(candles) ? candles : [],
        ai: ai || null,
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}