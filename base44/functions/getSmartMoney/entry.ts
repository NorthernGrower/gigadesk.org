import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { asArray } from "../../shared/market.ts";
import {
  fetchLeaderboard,
  rankTraders,
  fetchTraderPositions,
  computeBias,
  SMART_WINDOWS,
} from "../../shared/smartmoney.ts";

// A board this recent answers the next page load without reading the
// leaderboard again: that file is over five megabytes, and every visit to the
// desk page used to fetch it, parse it and ask a dozen wallets for their books.
const CACHE_MS = 3 * 60000;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const window = SMART_WINDOWS.includes(body.window) ? body.window : "week";
    const count = Math.min(20, Math.max(3, Number(body.count) || 12));
    const force = body.force === true;
    const svc = base44.asServiceRole;

    // The board this app saved on its last refresh. It answers a page load
    // while it is still fresh, and it is what the panel falls back to when a
    // public feed is down: the traders and the positions the bot scores with,
    // never an empty panel or a bare failure.
    const stored = async () => {
      const [tradersPage, positionsPage] = await Promise.all([
        svc.entities.SmartTrader.list({ limit: 40 }).catch(() => []),
        svc.entities.SmartPosition.list({ limit: 200 }).catch(() => []),
      ]);
      const rows = asArray(tradersPage).sort(
        (a, b) => (Number(b.pnl_usd) || 0) - (Number(a.pnl_usd) || 0),
      );
      const positions = asArray(positionsPage).sort(
        (a, b) => (Number(b.size_usd) || 0) - (Number(a.size_usd) || 0),
      );
      return {
        rows,
        positions,
        at: rows.reduce((newest, t) => Math.max(newest, Date.parse(t.fetched_at) || 0), 0),
      };
    };

    const answer = (traders, positions, at, why) =>
      Response.json({
        traders,
        positions,
        bias: computeBias(positions),
        fetched_at: at ? new Date(at).toISOString() : null,
        error: why,
      });

    if (!force) {
      const cached = await stored();
      const forWindow = cached.rows.filter((t) => (t.window || "week") === window);
      if (forWindow.length && Date.now() - cached.at < CACHE_MS) {
        return answer(
          forWindow.slice(0, count).map((t, i) => ({ ...t, rank: i + 1 })),
          cached.positions,
          cached.at,
          null,
        );
      }
    }

    const fallback = async (why) => {
      const saved = await stored();
      const forWindow = saved.rows.filter((t) => (t.window || "week") === window);
      const rows = (forWindow.length ? forWindow : saved.rows).slice(0, count);
      return answer(
        rows.map((t, i) => ({ ...t, rank: i + 1 })),
        saved.positions,
        saved.at,
        why,
      );
    };

    let board = [];
    try {
      board = await fetchLeaderboard();
    } catch (error) {
      return fallback(
        `The on-chain leaderboard is not answering right now (${(error && error.message) || "no response"}).`,
      );
    }

    const traders = rankTraders(board, { window, count });
    if (!traders.length) {
      // an empty rank is the filters being strict, not a fault: the board's
      // accounts did not clear the size and volume this desk tracks
      return fallback(
        "No trader on the leaderboard cleared the desk's size and volume filters in this window.",
      );
    }

    // positions for the tracked traders, fetched in small parallel batches
    const positions = [];
    let unread = 0;
    for (let i = 0; i < traders.length; i += 6) {
      const batch = traders.slice(i, i + 6);
      const settled = await Promise.allSettled(batch.map((t) => fetchTraderPositions(t.wallet)));
      settled.forEach((s, j) => {
        if (s.status === "fulfilled") {
          for (const p of s.value) positions.push({ ...p, trader_rank: batch[j].rank });
        } else {
          unread += 1;
        }
      });
    }
    const now = new Date().toISOString();
    const at = Date.parse(now);

    // Saving is best effort. The board is the answer, and a write the app
    // refuses must never turn a working refresh into a failed panel.
    try {
      await svc.entities.SmartTrader.upsert(
        traders.map((t) => ({
          ...t,
          open_positions: positions.filter((p) => p.wallet === t.wallet).length,
          fetched_at: now,
        })),
        { key: "wallet" },
      );
      if (positions.length) {
        await svc.entities.SmartPosition.upsert(
          positions.map((p) => ({ ...p, fetched_at: now })),
          { key: ["wallet", "symbol"] },
        );
      }
      // drop what fell off the board, only once this refresh was written
      await svc.entities.SmartTrader.deleteMany({ fetched_at: { $lt: now } }).catch(() => {});
      // every book was read, so a position missing now is closed now
      if (!unread)
        await svc.entities.SmartPosition.deleteMany({ fetched_at: { $lt: now } }).catch(() => {});
    } catch (error) {
      console.log(`Smart money snapshot not saved: ${(error && error.message) || error}`);
    }

    return answer(traders, positions, at, null);
  } catch (error) {
    // The page keeps only the status code of a failed call, so the reason
    // travels in the body instead: a 200 with the message is what the panel
    // can show, where a 500 reaches it as "Request failed with status code 500".
    return Response.json(
      { error: (error && error.message) || "Smart money refresh failed", traders: [], positions: [], bias: [] },
      { status: 200 },
    );
  }
}
