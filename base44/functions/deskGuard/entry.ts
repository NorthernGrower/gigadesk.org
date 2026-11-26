import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { asArray, round, fetchLivePrices } from '../../shared/market.ts';
import { placeMarketOrder, resolveLiveConnection } from '../../shared/orders.ts';
import { isBackedOff } from '../../shared/exchanges.ts';
import { liveRule } from '../../shared/deskRules.ts';
import { toUsd } from '../../shared/quotes.ts';
import { safetyExit, profitLock } from '../../shared/risk.ts';
import { recordLesson } from '../../shared/learn.ts';

// The desk's safety net, on a schedule. Until now a live position's stop was
// only checked inside a bot cycle, and a bot cycle only runs while the app is
// open: with the app closed — or while the cycle itself was failing — nothing
// looked at a stop at all, so a position could run straight past it. This runs
// on the platform's own schedule (Desk Guard workflow), with the app closed.
//
// It is deliberately narrower than a bot cycle: it *only* closes, and only on
// the two safety rules — a breached stop and the per-trade loss cap. Targets,
// break-even, trailing, scale-outs, mood flips, entries and the scan all stay
// in the app's cycle, because none of them can lose money by waiting.
//
// One run per window keeps a repeated hit on this URL from firing signed sells
// into every user's exchange again.
const RUN_KEY = "desk_guard";
const RUN_COOLDOWN_MS = 3 * 60 * 1000;

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    // Admin-only: the run decrypts every user's stored keys and can place real
    // sells. The scheduled workflow calls it as its creator (an app admin).
    const user = await base44.auth
      .me()
      .catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const lastRun = asArray(
      await base44.asServiceRole.entities.MarketCache.filter({ key: RUN_KEY }, { limit: 1 }),
    )[0];
    const lastAt = Number((lastRun && lastRun.value && lastRun.value.at) || 0);
    if (Date.now() - lastAt < RUN_COOLDOWN_MS)
      return Response.json({ checked: 0, skipped: "recent_run" });
    await base44.asServiceRole.entities.MarketCache
      .upsert([{ key: RUN_KEY, value: { at: Date.now() } }], { key: "key" })
      .catch(() => {});

    const configs = asArray(
      await base44.asServiceRole.entities.BotConfig.filter({}, { sort: "-updated_date", limit: 50 }),
    );
    const owners = [];
    const seen = new Set();
    for (const config of configs) {
      // one set of rules per desk: only the freshest config governs an owner
      if (!config.created_by_id || seen.has(config.created_by_id)) continue;
      seen.add(config.created_by_id);
      const LR = config.live_rules || {};
      // only the bot's own real positions: a fill the user logged by hand, or
      // one with bot handling off, is theirs to manage and never touched here
      const open = asArray(
        await base44.asServiceRole.entities.Trade.filter(
          { created_by_id: config.created_by_id, mode: "real", status: "open" },
          { limit: 200 },
        ),
      ).filter((t) => t.exchange_order_id && t.bot_handling !== false);
      if (!open.length) continue;
      // managing a position must keep working while new live entries are paused
      const live = await resolveLiveConnection(base44, config, { manage: true });
      if (!live.conn) {
        owners.push({ owner: config.created_by_id, skipped: live.reason, closed: [] });
        continue;
      }
      const connRow = await base44.asServiceRole.entities.ExchangeConnection
        .get(live.conn.id)
        .catch(() => null);
      // a locked key needs silence to clear: a signed close attempt would
      // count against the lockout and extend it, so this pass waits it out
      if (isBackedOff(connRow)) {
        owners.push({ owner: config.created_by_id, skipped: "key lockout", closed: [] });
        continue;
      }

      const symbols = [...new Set(open.map((t) => String(t.symbol || "").toUpperCase()))];
      const prices = await fetchLivePrices([...symbols, "BTC"]);
      const btcUsd = Number(prices.get("BTC")) || 0;
      const maxLossPct = Number(liveRule(LR, "max_trade_loss_pct", 20)) || 0;
      const leverage = Number(liveRule(LR, "margin_leverage", 2)) || 2;
      // the profit lock's own settings: a trade must be up by the arm
      // threshold, and from then on it may give back no more than the share
      const lockOn = liveRule(LR, "profit_lock", true) !== false;
      const lockArmPct = Number(liveRule(LR, "lock_arm_pct", 2)) || 0;
      const lockGivebackPct = Number(liveRule(LR, "giveback_pct", 50)) || 0;
      const closed = [];
      // stops this pass raised to lock in profit, for the summary
      let trailed = 0;

      for (const t of open) {
        const quote = String(t.quote_asset || "").toUpperCase() === "BTC" ? "BTC" : "USD";
        // a BTC-quoted position's levels are in bitcoin: its tape is the
        // pair's price, taken from the same dollar quote at the rate
        const fx = quote === "BTC" ? btcUsd : 1;
        if (!(fx > 0)) continue;
        const priceUsd = Number(prices.get(String(t.symbol || "").toUpperCase())) || 0;
        if (!(priceUsd > 0)) continue; // cannot price it: leave it for the next pass
        const price = quote === "BTC" ? priceUsd / fx : priceUsd;
        const side = t.side === "short" ? "short" : "long";
        const entry = Number(t.entry_price) || 0;
        if (!(entry > 0)) continue;
        // the profit lock: a position up by the desk's arm threshold has its
        // stop raised to keep a share of the best price it reached — so a run
        // like this one's +5% books most of itself instead of riding back
        // down to the entry stop. It runs here, on the schedule, so it holds
        // while the app is closed, and it can only ever raise a stop.
        let stop = Number(t.stop_price) || (side === "long" ? entry * 0.975 : entry * 1.025);
        const update: Record<string, any> = {};
        if (lockOn) {
          const lock = profitLock({
            side,
            entry,
            stop,
            peak: t.peak_price,
            price,
            armPct: lockArmPct,
            givebackPct: lockGivebackPct,
          });
          if (lock) {
            if (round(lock.peak, 8) !== round(Number(t.peak_price) || 0, 8))
              update.peak_price = round(lock.peak, 8);
            if (lock.raised) {
              const moved = stop > 0 ? Math.abs(lock.stop - stop) / stop : 1;
              stop = lock.stop;
              trailed += 1;
              update.stop_price = round(lock.stop, 8);
              // a V3 or measured-exit position reads its own stop field, so
              // both move together: a raised stop can never be ignored
              if (t.v3_algo === true) update.v3_stop = round(lock.stop, 8);
              // only a stop that actually moved matters, so the feed is told
              // once per raise instead of on every pass
              if (moved > 0.001)
                await base44.asServiceRole.entities.Alert.create({
                  symbol: t.symbol,
                  title: `${t.symbol} stop raised to lock in profit`,
                  message: `${side === "long" ? "Long" : "Short"} up ${round(((side === "long" ? price - entry : entry - price) / entry) * 100, 2)}% — the stop moved to ${round(lock.stop, 8)}${
                    quote === "BTC" ? " BTC" : ""
                  }, keeping ${round(100 - lockGivebackPct)}% of the peak. It can only ever move up, never down.`,
                  mode: "live",
                  kind: "bot_open",
                  severity: "info",
                  trade_id: t.id,
                  created_by_id: config.created_by_id,
                }).catch(() => {});
            }
          }
        }
        // the same rule the cycle decides from, so the two can never disagree
        // about whether a stop was hit or where it fills
        const decision = safetyExit({ side, entry, stop, price, maxLossPct });
        if (!decision) {
          // nothing closed: persist the raised stop and the new peak, or the
          // next pass would forget it and the lock would never ratchet
          if (Object.keys(update).length)
            await base44.asServiceRole.entities.Trade.update(t.id, update).catch(() => {});
          continue;
        }
        const exitPrice = decision.price;
        const reason = decision.reason;
        // the app and this pass can meet on the same position: the row is
        // re-read so only the first writer sends a sell, never both
        const current = await base44.asServiceRole.entities.Trade.get(t.id).catch(() => null);
        if (!current || current.status !== "open") continue;
        const order = await placeMarketOrder(live.conn, {
          symbol: t.symbol,
          side: side === "short" ? "buy" : "sell",
          quantity: Number(t.quantity) || 0,
          ...(quote === "BTC" ? { quote: "BTC" } : {}),
          ...(side === "short" ? { margin: true, leverage } : {}),
        });
        if (!order.ok && !order.dust) {
          await base44.asServiceRole.entities.Alert.create({
            symbol: t.symbol,
            title: `Could not close ${t.symbol} on the desk guard`,
            message: order.message,
            mode: "live",
            kind: "order_failed",
            severity: "danger",
            trade_id: t.id,
            created_by_id: config.created_by_id,
          });
          continue;
        }
        // an exchange fill is the real price when it reports one; the booked
        // level stands in when it does not, exactly as the cycle books it
        const filled = Number(order.avg_price) || exitPrice;
        const qty = Number(t.quantity) || 0;
        const size = Number(t.size_usd) || 0;
        const pnlInQuote =
          side === "long" ? (filled - entry) * qty : (entry - filled) * qty;
        const pnl = toUsd(pnlInQuote, quote, fx);
        const pnlPct = size ? (pnl / size) * 100 : 0;
        const dustNote = order.dust
          ? `The exchange holds ${order.held_qty} ${t.symbol}, below its minimum sellable amount — closed on the desk without an order. `
          : "";
        await base44.asServiceRole.entities.Trade.update(t.id, {
          status: "closed",
          exit_price: round(filled, 8),
          pnl_usd: round(pnl),
          pnl_pct: round(pnlPct),
          closed_at: new Date().toISOString(),
          exit_reason: reason,
        });
        await base44.asServiceRole.entities.Alert.create({
          symbol: t.symbol,
          title: `${t.symbol} closed ${pnl >= 0 ? "in profit" : "at a loss"} (${round(pnlPct)}%)`,
          message:
            dustNote +
            `${
              reason === "stop"
                ? `Stop hit at ${round(filled, 8)}${quote === "BTC" ? " BTC" : ""}`
                : `Per-trade loss cap reached at ${round(filled, 8)}${quote === "BTC" ? " BTC" : ""}`
            } — closed by the desk guard while the app was closed. P&L ${round(pnl)} USD.`,
          mode: "live",
          kind: reason === "stop" ? "stop_hit" : "bot_close",
          severity: dustNote ? "warning" : pnl >= 0 ? "success" : "danger",
          trade_id: t.id,
          created_by_id: config.created_by_id,
        });
        // the result carries into the desk's own pattern lessons, exactly as a
        // cycle close does
        await recordLesson(base44, { ...t, quote_asset: quote }, pnlPct, pnl, reason).catch(() => {});
        closed.push({ symbol: t.symbol, side, reason, exit_price: round(filled, 8), pnl_usd: round(pnl) });
      }
      owners.push({ owner: config.created_by_id, exchange: live.conn.label, closed, locked: trailed });
    }

    // per-owner summaries carry other users' positions for an admin caller
    return Response.json({ owners: owners.length, closed: owners.reduce((a, o) => a + o.closed.length, 0), reported: owners });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
