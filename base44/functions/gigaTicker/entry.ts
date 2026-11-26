import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { asArray } from '../../shared/market.ts';

const BASE = 1_000_000; // the ad desk's demo equity
const TTL = 60_000;
const CACHE_KEY = 'giga_ticker';
let cache = null;

export default async function (req) {
  try {
    if (cache && Date.now() - cache.at < TTL) return Response.json(cache.value);
    const base44 = createClientFromRequest(req);

    // Deliberately public advertisement stats: aggregates only, never per-user
    // rows, so the landing ticker works for signed-out visitors too. Nothing
    // personal can be read here, and nothing is written except this cache.
    // The aggregate is kept on the app as well as in memory, so a burst of
    // anonymous visitors runs seven sums once a minute, not once each.
    const stored = asArray(
      await base44.asServiceRole.entities.MarketCache
        .filter({ key: CACHE_KEY }, { limit: 1 })
        .catch(() => []),
    )[0];
    const storedAt = Number(((stored || {}).value || {}).at) || 0;
    if (stored && storedAt && Date.now() - storedAt < TTL && (stored.value || {}).data) {
      cache = { value: stored.value.data, at: storedAt };
      return Response.json(cache.value);
    }

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [closedAgg, winsAgg, todayAgg, startAgg, bestAgg, openAgg, decisiveAgg] = await Promise.all([
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'closed' }, sum: 'pnl_usd' }),
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'closed', pnl_usd: { $gt: 0 } } }),
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'closed', closed_at: { $gte: dayStart.toISOString() } }, sum: 'pnl_usd' }),
      base44.asServiceRole.entities.BotConfig.aggregate({ query: {}, sum: 'starting_balance' }),
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'closed' }, max: 'pnl_usd' }),
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'open' } }),
      // win rate only counts trades that actually made or lost money; the
      // many flat "time" exits are break-even, not losses
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'closed', pnl_usd: { $ne: 0 } } }),
    ]);

    const closedRow = closedAgg?.rows?.[0] || {};
    const winsRow = winsAgg?.rows?.[0] || {};
    const todayRow = todayAgg?.rows?.[0] || {};
    const startRow = startAgg?.rows?.[0] || {};
    const bestRow = bestAgg?.rows?.[0] || {};
    const openRow = openAgg?.rows?.[0] || {};
    const decisiveRow = decisiveAgg?.rows?.[0] || {};

    const realized = Number(closedRow.sum_pnl_usd) || 0;
    const todayRealized = Number(todayRow.sum_pnl_usd) || 0;
    const startSum = Number(startRow.sum_starting_balance) || 0;
    const growth = startSum > 0 ? realized / startSum : 0;
    const closedCount = Number(closedRow.count) || 0;
    const wins = Number(winsRow.count) || 0;
    const decisiveCount = Number(decisiveRow.count) || 0;

    const value = {
      equity: Math.round(BASE * (1 + growth)),
      growth_pct: Math.round(growth * 10000) / 100,
      realized: Math.round(realized * 100) / 100,
      today_pnl: startSum > 0 ? Math.round(BASE * (todayRealized / startSum) * 100) / 100 : Math.round(todayRealized * 100) / 100,
      today_pct: startSum > 0 ? Math.round((todayRealized / startSum) * 10000) / 100 : 0,
      win_rate: decisiveCount ? Math.round((wins / decisiveCount) * 100) : 0,
      closed_count: closedCount,
      open_count: Number(openRow.count) || 0,
      best_trade: Math.round((Number(bestRow.max_pnl_usd) || 0) * 100) / 100,
      updated_at: new Date().toISOString(),
    };
    cache = { value, at: Date.now() };
    // the shared copy, so the next instance (and the next anonymous burst)
    // answers from here instead of running the sums again
    await base44.asServiceRole.entities.MarketCache
      .upsert([{ key: CACHE_KEY, value: { at: cache.at, data: value } }], { key: 'key' })
      .catch(() => {});
    return Response.json(value);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}