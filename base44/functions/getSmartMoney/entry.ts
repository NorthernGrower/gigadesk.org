import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import {
  fetchLeaderboard,
  rankTraders,
  fetchTraderPositions,
  computeBias,
  SMART_WINDOWS,
} from "../../shared/smartmoney.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const window = SMART_WINDOWS.includes(body.window) ? body.window : "week";
    const count = Math.min(20, Math.max(3, Number(body.count) || 12));

    const rows = await fetchLeaderboard();
    const traders = rankTraders(rows, { window, count });

    // positions for the tracked traders, fetched in small parallel batches
    const positions = [];
    for (let i = 0; i < traders.length; i += 6) {
      const batch = traders.slice(i, i + 6);
      const settled = await Promise.allSettled(batch.map((t) => fetchTraderPositions(t.wallet)));
      settled.forEach((s, j) => {
        if (s.status === "fulfilled") {
          for (const p of s.value) positions.push({ ...p, trader_rank: batch[j].rank });
        }
      });
    }
    const bias = computeBias(positions);
    const now = new Date().toISOString();

    // shared market data, identical for every user: written with the service
    // role after the auth check, so it stays readable by all and writable by none
    const svc = base44.asServiceRole;
    await svc.entities.SmartTrader.upsert(
      traders.map((t) => ({
        ...t,
        open_positions: positions.filter((p) => p.wallet === t.wallet).length,
        fetched_at: now,
      })),
      { key: "wallet" },
    );
    await svc.entities.SmartPosition.upsert(positions, { key: ["wallet", "symbol"] });
    // drop traders and positions that fell off the board since the last refresh
    await svc.entities.SmartTrader.deleteMany({ fetched_at: { $lt: now } });
    await svc.entities.SmartPosition.deleteMany({ fetched_at: { $lt: now } });

    return Response.json({ traders, positions, bias, fetched_at: now });
  } catch (error) {
    return Response.json({ error: (error && error.message) || "Smart money refresh failed" }, { status: 500 });
  }
}