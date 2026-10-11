import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';

const BASE = 1_000_000; // the ad desk's demo equity
const TTL = 60_000;
let cache = null;

export default async function (req) {
  try {
    if (cache && Date.now() - cache.at < TTL) return Response.json(cache.value);
    const base44 = createClientFromRequest(req);

    // Deliberately public advertisement stats: aggregates only, never per-user
    // rows, so the landing ticker works for signed-out visitors too.
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [closedAgg, winsAgg, todayAgg, startAgg, bestAgg, openAgg] = await Promise.all([
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'closed' }, sum: 'pnl_usd' }),
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'closed', pnl_usd: { $gt: 0 } } }),
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'closed', closed_at: { $gte: dayStart.toISOString() } }, sum: 'pnl_usd' }),
      base44.asServiceRole.entities.BotConfig.aggregate({ query: {}, sum: 'starting_balance' }),
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'closed' }, max: 'pnl_usd' }),
      base44.asServiceRole.entities.Trade.aggregate({ query: { status: 'open' } }),
    ]);

    const closedRow = closedAgg?.rows?.[0] || {};
    const winsRow = winsAgg?.rows?.[0] || {};
    const todayRow = todayAgg?.rows?.[0] || {};
    const startRow = startAgg?.rows?.[0] || {};
    const bestRow = bestAgg?.rows?.[0] || {};
    const openRow = openAgg?.rows?.[0] || {};

    const realized = Number(closedRow.sum_pnl_usd) || 0;
    const todayRealized = Number(todayRow.sum_pnl_usd) || 0;
    const startSum = Number(startRow.sum_starting_balance) || 0;
    const growth = startSum > 0 ? realized / startSum : 0;
    const closedCount = Number(closedRow.count) || 0;
    const wins = Number(winsRow.count) || 0;

    const value = {
      equity: Math.round(BASE * (1 + growth)),
      growth_pct: Math.round(growth * 10000) / 100,
      realized: Math.round(realized * 100) / 100,
      today_pnl: startSum > 0 ? Math.round(BASE * (todayRealized / startSum) * 100) / 100 : Math.round(todayRealized * 100) / 100,
      today_pct: startSum > 0 ? Math.round((todayRealized / startSum) * 10000) / 100 : 0,
      win_rate: closedCount ? Math.round((wins / closedCount) * 100) : 0,
      closed_count: closedCount,
      open_count: Number(openRow.count) || 0,
      best_trade: Math.round((Number(bestRow.max_pnl_usd) || 0) * 100) / 100,
      updated_at: new Date().toISOString(),
    };
    cache = { value, at: Date.now() };
    return Response.json(value);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}