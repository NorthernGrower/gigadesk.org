import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { asArray } from '../../shared/market.ts';

// Full paper-desk reset: wipes every paper trade, the equity chart history,
// the bot's lessons and the alerts those trades raised, then sets the paper
// balance back to the starting amount. Live (real) trades are never touched.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;

    const configs = asArray(
      await base44.asServiceRole.entities.BotConfig.filter(
        { created_by_id: user.id },
        { sort: '-updated_date', limit: 5 },
      ),
    );
    const config = configs[0];
    if (!config) return Response.json({ error: 'No bot rules found' }, { status: 404 });

    // page through every paper trade: the alert cleanup needs their ids
    const tradeIds = [];
    let cursor;
    do {
      const page = await base44.asServiceRole.entities.Trade.filter(
        { created_by_id: user.id, mode: 'paper' },
        { sort: '-created_date', limit: 200, ...(cursor ? { cursor } : {}) },
      );
      for (const t of asArray(page)) tradeIds.push(t.id);
      cursor = page && page.next_cursor;
    } while (cursor);

    const starting = Number(config.starting_balance) || 10000;
    const counts = { paper_trades: tradeIds.length, alerts: 0, equity_candles: 0, lessons: 0 };

    if (!dryRun) {
      for (const batch of chunkIds(tradeIds)) {
        const res = await base44.asServiceRole.entities.Alert.deleteMany({ trade_id: { $in: batch } });
        counts.alerts += countOf(res);
      }
      const dailyGoal = await base44.asServiceRole.entities.Alert.deleteMany({
        created_by_id: user.id,
        kind: 'daily_goal',
      });
      counts.alerts += countOf(dailyGoal);
      const trades = await base44.asServiceRole.entities.Trade.deleteMany({
        created_by_id: user.id,
        mode: 'paper',
      });
      counts.paper_trades = countOf(trades) || tradeIds.length;
      const candles = await base44.asServiceRole.entities.EquityCandle.deleteMany({ owner: user.id });
      counts.equity_candles = countOf(candles);
      const lessons = await base44.asServiceRole.entities.Lesson.deleteMany({ created_by_id: user.id });
      counts.lessons = countOf(lessons);
      // balance back to the starting amount; the next cycle re-anchors it
      // from the (now empty) trades, so the two agree exactly
      await base44.asServiceRole.entities.BotConfig.update(config.id, {
        cash_balance: starting,
      });
    }

    return Response.json({
      ok: true,
      dry_run: dryRun,
      counts,
      starting_balance: starting,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

function countOf(res) {
  if (res == null) return 0;
  if (typeof res === 'number') return res;
  if (typeof res === 'object') {
    for (const key of ['deleted', 'deleted_count', 'count', 'removed', 'n']) {
      const n = Number(res[key]);
      if (Number.isFinite(n)) return n;
    }
    if (Array.isArray(res.records)) return res.records.length;
  }
  return 0;
}

function chunkIds(ids, size = 200) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}