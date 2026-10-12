import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';

// One public setup, chosen from the day's top 10 desk picks, for the landing
// page ad. The choice is anchored to the UTC day, so every visitor sees the
// same call and it rotates by itself every 24 hours.
const AI_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["strong_long", "long", "watch", "short", "strong_short", "avoid"],
    },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    thesis: { type: "string" },
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
      ai = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: `You are a crypto desk analyst writing a short public promo read on one setup for a trading platform's homepage.

Coin: ${pick.name || pick.symbol} (${pick.symbol})
Side: ${pick.side} | price ${pick.price} USD | entry ${pick.entry} | target ${pick.target} | stop ${pick.stop} | required move ${pick.required_move_pct}% | risk/reward ${pick.risk_reward} | score ${pick.score}/100 (${pick.grade})
Desk reasons: ${(pick.reasons || []).join("; ")}

Write a punchy but honest thesis (max 55 words) on why this setup stands out today, and the main risks (max 35 words). Judge the direction. Never promise a return and never invent data beyond what is given.`,
        response_json_schema: AI_SCHEMA,
      }).catch(() => null);
      if (ai) {
        await base44.asServiceRole.entities.Signal.update(pick.id, {
          indicators: { ...(pick.indicators || {}), ai_featured: ai },
        });
      }
    }

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
        entry: pick.entry,
        target: pick.target,
        stop: pick.stop,
        required_move_pct: pick.required_move_pct,
        risk_reward: pick.risk_reward,
        reasons: pick.reasons || [],
        ai: ai || null,
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}