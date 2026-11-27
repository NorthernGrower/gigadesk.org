import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { liveRulesView } from "../../shared/deskRules.ts";
import { entryRulesFor } from "../../shared/entryRules.ts";
import { fetchCandles } from "../../shared/market.ts";
import { briefingPrompt, cleanBriefing, decayReport, deskDigest, learningReport, marketContext, BRIEFING_SCHEMA } from "../../shared/analyst.ts";

// The desk analyst: read-only commentary on one desk.
//
// There is deliberately no order path in this file — no exchange client, no
// trade write, no config write, no sizing. It reads the desk's own records and
// the market context, computes the numbers in shared/analyst.ts, and has a model
// put them into words. The note is written once a day and kept; the numbers and
// the context are read fresh on every call. A model failure returns the numbers
// without the prose rather than failing the page, and a desk with the switch off
// is answered without any read or model call at all.
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

    // what the bot learned from its closed calls: the same records the panel
    // reads, grouped by pattern and by exit, with the score bump each pattern
    // has actually earned. Read fresh on every call and passed to the note, so
    // the analyst never has to guess what the bot has been learning.
    stage = "lessons";
    const learned = learningReport(
      list(
        await base44.entities.Lesson
          .filter({ created_by_id: owner }, { sort: "-created_date", limit: 500 })
          .catch(() => []),
      ),
    );

    // what the desk can see beside its own trades: the scanner's setups, the BTC
    // tape, this desk's recent alerts and the watchlist. Read fresh on every
    // call — they are cheap. Each read fails soft, so a missing read leaves its
    // part empty instead of failing the page.
    stage = "context";
    const nowMs = Date.now();
    const [signalPage, alertPage, watchPage, btcDaily] = await Promise.all([
      base44.asServiceRole.entities.Signal.filter({ status: "new" }, { sort: "-score", limit: 100 }).catch(() => []),
      base44.entities.Alert.filter({ created_by_id: user.id }, { sort: "-created_date", limit: 40 }).catch(() => []),
      base44.entities.Watchlist.list({ limit: 60 }).catch(() => []),
      fetchCandles("BTC", "1d", 260).catch(() => null),
    ]);
    const context = marketContext({
      desk,
      // a desk running V3 never reads the score bar, so its setups are not
      // labelled against a bar it does not use
      scored: view.v3_algo !== true,
      scoreBar: view.v3_algo === true ? 0 : entryRulesFor(view, desk).min_score,
      nowMs,
      signals: list(signalPage),
      alerts: list(alertPage),
      watchlist: list(watchPage),
      btcDaily,
    });

    // one note per desk per day. A stored note holds for the day, and asking
    // again is the only thing that writes a fresh one. A failed model call is
    // retried on the next visit, but only after 15 minutes, so a model that
    // keeps failing is not called on every visit.
    stage = "cache";
    const day = new Date().toISOString().slice(0, 10);
    // a stored note is a convenience, never a requirement: on the first
    // publish of this function the collection may not exist yet, and that
    // must cost a cache miss, not the whole read
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
    const holds = !!existing && (!existing.model_error || ageMs < 15 * 60000);
    if (holds && !force) {
      return Response.json({ enabled: true, cached: true, note: existing, digest, decay, learned, context });
    }

    stage = "model";
    let brief = null;
    let modelError = null;
    try {
      const raw = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: briefingPrompt(digest, decay, context, learned),
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
      learned,
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

    return Response.json({ enabled: true, cached: false, note, digest, decay, learned, context, error: modelError });
  } catch (error) {
    return Response.json(
      { error: `${stage}: ${String((error && error.message) || error)}` },
      { status: 500 },
    );
  }
}
