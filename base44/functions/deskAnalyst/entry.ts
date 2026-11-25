import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { liveRulesView } from "../../shared/deskRules.ts";
import { briefingPrompt, cleanBriefing, decayReport, deskDigest, BRIEFING_SCHEMA } from "../../shared/analyst.ts";

// The desk analyst: read-only commentary on one desk.
//
// There is deliberately no order path in this file — no exchange client, no
// trade write, no config write, no sizing. It reads the desk's own records,
// computes the numbers in shared/analyst.ts, and has a model put them into
// words. A model failure returns the numbers without the prose rather than
// failing the page, and a desk with the switch off is answered without a model
// call at all.
const list = (page) => (Array.isArray(page) ? page : (page && page.items) || []);

export default async function (req) {
  let stage = "setup";
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const desk = body.desk === "live" ? "live" : "paper";
    const force = body.force === true;

    stage = "config";
    const config = list(
      await base44.entities.BotConfig.filter(
        { created_by_id: user.id },
        { sort: "-updated_date", limit: 1 },
      ),
    )[0];
    if (!config) return Response.json({ enabled: false, desk, reason: "Save the bot rules first" });

    // each desk reads only its own saved rules — the live desk never borrows a
    // paper value, so switching the analyst on for one can not switch the other
    stage = "toggle";
    const view = desk === "live" ? liveRulesView(config) : config;
    if (view.analyst_on !== true) {
      return Response.json({ enabled: false, desk, reason: "The desk analyst is off for this desk" });
    }

    // entity reads cap each page, so a plain read silently misses trades once
    // the desk has more than one page of them
    const readAll = async (query, sort = "-created_date") => {
      const out = [];
      let cursor;
      do {
        const page = await base44.entities.Trade.filter(query, {
          sort,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        out.push(...list(page));
        cursor = page && page.next_cursor;
      } while (cursor);
      return out;
    };

    stage = "trades";
    const owner = config.created_by_id || user.id;
    const mode = desk === "live" ? "real" : "paper";
    const since = new Date(Date.now() - 180 * 86400000).toISOString();
    const [closedPage, openPage] = await Promise.all([
      readAll({ status: "closed", created_by_id: owner, closed_at: { $gte: since } }),
      readAll({ status: "open", created_by_id: owner }),
    ]);
    const closed = closedPage.filter((t) => (t.mode || "paper") === mode);
    const open = openPage.filter((t) => (t.mode || "paper") === mode);

    const digest = deskDigest({ desk, closed, open, config: view });
    const decay = decayReport(closed);

    // one note per desk per day, refreshed on demand: the panel may ask on
    // every visit without paying for a model read each time
    stage = "cache";
    const day = new Date().toISOString().slice(0, 10);
    // a stored note is a convenience, never a requirement: on the first
    // publish of this function the collection may not exist yet, and that
    // must cost a cache hit, not the whole read
    let existing = null;
    try {
      existing =
        list(
          await base44.asServiceRole.entities.DeskBriefing.filter({ owner: user.id, desk, day }, { limit: 1 }),
        )[0] || null;
    } catch (err) {
      console.log(`desk analyst cache read skipped: ${String((err && err.message) || err)}`);
    }
    const ageMs = existing && existing.generated_at ? Date.now() - Date.parse(existing.generated_at) : Infinity;
    if (existing && !force && ageMs < 20 * 60000) {
      return Response.json({ enabled: true, cached: true, note: existing, digest, decay });
    }

    stage = "model";
    let brief = null;
    let modelError = null;
    try {
      const raw = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: briefingPrompt(digest, decay),
        response_json_schema: BRIEFING_SCHEMA,
      });
      brief = cleanBriefing(raw);
      if (!brief) modelError = "The model returned nothing usable";
    } catch (err) {
      modelError = String((err && err.message) || err);
      console.log(`desk analyst model call failed: ${modelError}`);
    }

    stage = "save";
    const row = {
      owner: user.id,
      desk,
      day,
      generated_at: new Date().toISOString(),
      digest,
      decay,
      ...(brief || {}),
      model_error: modelError || "",
    };
    let note = row;
    try {
      const saved = list(await base44.entities.DeskBriefing.upsert([row], { key: ["owner", "desk", "day"] }));
      if (saved[0]) note = saved[0];
    } catch (err) {
      // a saved row is a convenience, not the point: the note still renders
      console.log(`desk analyst note not saved: ${String((err && err.message) || err)}`);
    }

    return Response.json({ enabled: true, cached: false, note, digest, decay, error: modelError });
  } catch (error) {
    return Response.json(
      { error: `${stage}: ${String((error && error.message) || error)}` },
      { status: 500 },
    );
  }
}
