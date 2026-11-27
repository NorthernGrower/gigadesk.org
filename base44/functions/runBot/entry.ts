import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { fetchMarkets, fetchCandles, fetchLivePrices, chunk, asArray, round } from "../../shared/market.ts";
import { analyzeCoin } from "../../shared/strategy.ts";
import { scanBoard, resolveDeskVenue, resolveBtcVenue } from "../../shared/scan.ts";
import { QUOTE_ASSET, placeMarketOrder, resolveLiveConnection } from "../../shared/orders.ts";
import { readAccount, fetchListedSymbols, fetchMarketConstraints, accountValueUsd, pickFundingQuote, pickBtcBalance, keepBalances, isBackedOff, backoffUntil, balanceJustRead, SHORT_VENUES } from "../../shared/exchanges.ts";
import { entryContext, excursionOf, loadLessons, outcomeFields, recordLesson, riskPctAt, rulesSnapshot } from "../../shared/learn.ts";
import { collectGateLocks, raiseGateLockAlerts } from "../../shared/rulelock.ts";
import { entryMinimum, entryRulesFor, gateReason as gateReasonShared, liveEntrySize } from "../../shared/entryRules.ts";
import { loadSmartBias } from "../../shared/smartmoney.ts";
import { liveRule, liveRulesView } from "../../shared/deskRules.ts";
import { syncExchangePositions } from "../../shared/reconcile.ts";
import { btcTrendUp, evaluateV3, v3ExitDue, v3Plan, V3 } from "../../shared/v3algo.ts";
import { detectHarmonic, HARMONIC } from "../../shared/harmonics.ts";
import { readDominance } from "../../shared/dominance.ts";
import { usdInQuote, quoteOf, patternFor } from "../../shared/quotes.ts";
import { capPositionSize, losingStreak, riskState, profitLock } from "../../shared/risk.ts";
import { pickTopPicks } from "../../shared/topPicks.ts";
import { toUsd, toQuote } from "../../shared/quotes.ts";
import { btcBookView, seedBookRules, btcSpendLimit } from "../../shared/bookRules.ts";

const DEFAULT_CONFIG = {
  mode: "approve",
  starting_balance: 10000,
  cash_balance: 10000,
  risk_per_trade_pct: 4,
  max_open_positions: 8,
  default_stop_pct: 2.5,
  target_pct: 2,
  daily_target_pct: 2,
  trailing_stop: true,
  trailing_trigger_pct: 3,
  trailing_distance_pct: 1.5,
  allow_shorts: true,
  timeframe: "1h",
  market_cap_scope: "all",
  min_score: 62,
  require_daily_target: true,
  cooldown_minutes: 120,
  auto_run: true,
  real_orders_enabled: false,
  real_connection_id: "",
  real_sizing_mode: "paper",
  fixed_order_usd: 100,
  live_cap_usd: 0,
  trading_style: "mild",
  profit_mode: "compound",
  max_trade_loss_pct: 20,
  pyramid: false,
  pyramid_trigger_pct: 1.5,
  combo_engine: true,
  margin_engine: false,
  sentiment_watch: true,
  confluence_v2: true,
  champion_engine: true,
  active_desk: "paper",
  v3_algo: false,
  v3_profile: "loose",
  always_take_top: false,
  always_take_count: 5,
};


// Where the cycle was when it threw. The outer catch sees only the error, so a
// failed cycle answered with a bare "status code 500" that named nothing and
// could not be acted on. Every stage below sets this label before its awaits,
// so the error the desk shows says which part of the cycle stopped it.
export default async function (req) {
  let stage = "setup";
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const light = body.light === true;
    const dryRun = body.dry_run === true;

    // one set of rules only: keep the freshest config and remove stray older
    // ones, so every cycle and screen agrees on a single balance — scoped to
    // the requesting user, so a desk can never read or delete another user's
    // configuration
    const configs = asArray(
      await base44.entities.BotConfig.filter(
        { created_by_id: user.id },
        { sort: "-updated_date", limit: 10 },
      ),
    );
    if (!dryRun) for (const extra of configs.slice(1)) await base44.entities.BotConfig.delete(extra.id);
    let config = configs[0];
    if (!config && dryRun) return Response.json({ error: "Save bot rules before checking entries" }, { status: 400 });
    if (!config) config = await base44.entities.BotConfig.create(DEFAULT_CONFIG);

    // fully separate desk rules: the live desk reads only its own saved
    // live_rules and the standalone live defaults (deskRules) — a paper
    // value is never a fallback, so changing the paper desk can never move
    // the live one, and the other way around
    const LR = config.live_rules || {};
    const lrVal = (key, fb) => liveRule(LR, key, fb);
    const liveConfigView = { ...config, real_connection_id: lrVal("real_connection_id", "") || "" };
    const deskView = (desk) =>
      desk === "live" ? liveRulesView(config) : config;
    const liveView = deskView("live");
    const paperView = deskView("paper");
    // the V3 algorithm is a different strategy, not a filter on the scored
    // engines: a desk that runs it takes both its entries and its exits from
    // the daily gates — 2xATR stop, no target, a 30-bar horizon. Each desk
    // switches it on for itself (paper: v3_algo, live: live_rules.v3_algo).
    const v3On = (view) => view.v3_algo === true;
    // per-desk engine stack: engine flags and the target placement each desk
    // trades by (3R margin, 6R combo, 2.5R old engine)
    const deskEngine = (v) => {
      const engineV2 = v.engine_v2 !== false;
      const champion = v.champion_engine !== false;
      const comboOn = v.combo_engine !== false;
      const marginOn = v.margin_engine === true;
      return {
        engineV2,
        champion,
        comboOn,
        marginOn,
        leverage: Math.max(1, Math.min(5, Number(v.margin_leverage) || 2)),
        targetR: marginOn ? 3 : comboOn ? 6 : engineV2 && champion ? 2.5 : null,
      };
    };
    const paperEngine = deskEngine(paperView);
    const liveEngine = deskEngine(liveView);

    // ---- the Bitcoin books' own rules. Each Bitcoin book keeps a rule set of its
    // own (btc_rules on paper, live_btc_rules live), seeded once from the dollar
    // desk's current values so nothing changes on upgrade. Every Bitcoin leg reads
    // its own view; the trade logic and the engines stay shared.
    if (!dryRun) {
      const seedPatch = {};
      if (!config.btc_rules) seedPatch.btc_rules = seedBookRules(paperView);
      if (!LR.live_btc_rules) seedPatch.live_rules = { ...LR, live_btc_rules: seedBookRules(liveView) };
      if (Object.keys(seedPatch).length) {
        await base44.entities.BotConfig.update(config.id, seedPatch);
        Object.assign(config, seedPatch);
      }
    }
    const paperBtcView = btcBookView(paperView, (config.btc_rules || {}));
    // the seeded live set is read off the config, not the pre-seed snapshot
    const liveBtcView = btcBookView(liveView, (config.live_rules || {}).live_btc_rules);
    const paperBtcEngine = deskEngine(paperBtcView);
    const liveBtcEngine = deskEngine(liveBtcView);
    // the share of the account's spot Bitcoin the live Bitcoin book may put to
    // work, and the hard ceiling it must stay under: its own rules, 1 to 100 and
    // 0 for no cap, with 100 and no cap keeping today's behaviour. The two
    // combine, so the smaller wins (see btcSpendLimit). Neither resizes a
    // position already open — together they cap what new entries may spend.
    const btcUsePct = Math.max(1, Math.min(100, Number(liveBtcView.btc_use_pct) || 100));
    const btcCapBtc = Math.max(0, Number(liveBtcView.btc_cap_btc) || 0);

    // single-flight: a cycle that started moments ago is still scanning, and
    // two overlapping cycles read the same empty state and opened the same
    // position twice. A fresh start timestamp makes later cycles stagger.
    const startedAt = config.last_cycle_started_at
      ? Date.parse(config.last_cycle_started_at)
      : 0;
    // only full cycles scan and trade, so only they share the single-flight
    // guard: a cheap light cycle must never block the desk's fresh scan
    const full = !dryRun && !light;
    const cycleInFlight = full && startedAt > 0 && Date.now() - startedAt < 45000;
    // claim the cycle slot, then verify the claim stuck: two cycles starting
    // in the same instant both read the old timestamp and both passed the
    // window above — the read-back catches the loser, which manages exits
    // only and skips the scan, so it can never open duplicate positions
    let claimConfirmed = false;
    if (full) {
      const claim = new Date().toISOString();
      await base44.entities.BotConfig.update(config.id, { last_cycle_started_at: claim });
      const fresh = asArray(
        await base44.entities.BotConfig.filter(
          { created_by_id: user.id },
          { sort: "-updated_date", limit: 1 },
        ),
      )[0];
      claimConfirmed = !fresh || fresh.last_cycle_started_at === claim;
    }

    // light cycles only manage open positions — their prices come from the
    // batched live feed, so the whole-market fetch (and its cap-feed probes,
    // which took tens of seconds whenever a provider was down) is skipped
    // entirely: the desk load waits on this call, so it must stay fast
    // the venue this desk trades on: its own market snapshot, candles and
    // listings drive the scan, so every exchange the user connected is scanned
    // on the coins it actually lists
    stage = "markets";
    const scanVenue = light ? null : await resolveDeskVenue(base44, config);
    // the connected exchange that can serve the Bitcoin book: its own spot market
    // lists the pairs quoted in bitcoin, so it is the only venue the book may be
    // scanned, charted and traded on. A desk with no such connection gets no
    // Bitcoin scan at all — rather than a market it has no account on — and the
    // reason travels back to the desk with the cycle. It is resolved on light
    // passes too: those carry no scan, and the desk would otherwise read that
    // it has no connected exchange on every quiet refresh
    const btcVenue = await resolveBtcVenue(base44, config);
    const { coins } = light ? { coins: [] } : await fetchMarkets(base44.asServiceRole, scanVenue);
    const priceMap = new Map(coins.map((c) => [c.symbol, c]));

    // Engine stacks resolve per desk (deskEngine above): each desk trades by
    // its own engine flags and target placement.

    // entity reads cap each page, so a plain read silently missed open trades
    // once the desk held more than a page — the exact window that let already
    // open symbols be traded again. Page through until every match is in.
    async function readAll(query, sort = "-created_date") {
      const out = [];
      let cursor;
      do {
        const page = await base44.entities.Trade.filter(query, {
          sort,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        out.push(...asArray(page));
        cursor = page && page.next_cursor;
      } while (cursor);
      return out;
    }

    // one query for every open trade: the paper desk manages its own records
    // from this list and the live block filters out the real ones, instead of
    // paying for a second identical read that only doubled entity traffic
    // the open-trade read and the live-connection resolution are independent —
    // one parallel round instead of two serial waits — and the read is scoped
    // to the requesting user: another user's open paper positions are their
    // desk's business, never this cycle's (a shared read here let one desk's
    // exits close another user's trades)
    const [openTrades, managedRes] = await Promise.all([
      readAll({ status: "open", created_by_id: config.created_by_id || user.id }),
      resolveLiveConnection(base44, liveConfigView, { manage: true, readOnly: dryRun }),
    ]);

    // live prices for every symbol with an open position: one batched public
    // call keeps exits (stop/target/trailing) on the real tape instead of the
    // up-to-a-minute-old market snapshot, without per-symbol API calls.
    // BTC always rides along: it is the rate every Bitcoin-book figure is
    // translated at, and a light cycle carries no market snapshot to read it
    // from — which left a Bitcoin holding valued at zero and skipped the
    // Bitcoin book's positions on the desk's fast pass.
    const livePrices = await fetchLivePrices([
      ...new Set([...openTrades.map((t) => String(t.symbol || "").toUpperCase()), "BTC"]),
    ]);
    for (const [sym, px] of livePrices) {
      const coin = priceMap.get(sym);
      if (coin && px > 0) coin.price = px;
      // wallet-imported positions can sit on coins the US feed does not list:
      // give them a live-priced row so the bot still manages them
      if (!coin && px > 0)
        priceMap.set(sym, { symbol: sym, name: sym, coingecko_id: "", image: "", price: px, market_cap: 0, volume24h: 0, change24h: 0, rank: 0 });
    }
    // managing existing real positions must work even while new live entries
    // are paused — the pause gates entries, never risk management
    const managed = managedRes;
    const live = config.real_orders_enabled === true
      ? managed
      : { conn: null, reason: "Live trading is paused", info: managed.info };
    // a live Bitcoin entry is placed on the venue that lists the pair, so the
    // live connection itself must be the Bitcoin venue: a KuCoin account never
    // buys a Kraken-only pair, and this book then runs paper only
    const liveBtcVenue =
      btcVenue != null && live.conn != null &&
      String(live.conn.exchange) === String(btcVenue.exchange);
    // a check can flag a key (temporary lockout, a revoked permission) without
    // the key being unusable — management still attempts real orders through
    // it, but new live entries keep requiring a verified, trading-enabled
    // connection, so flagged keys never fire fresh buys
    const liveVerified =
      !!managed.info && managed.info.status === "connected" && managed.info.allow_trading === true;
    // the connection row is read even while new live entries are paused: the
    // desk still shows the account's own Bitcoin, and a paused desk must never
    // read as an account that holds none
    const connId = managed.conn ? managed.conn.id : managed.info ? managed.info.id : null;
    const connRow = connId
      ? await base44.asServiceRole.entities.ExchangeConnection
          .get(connId)
          .catch(() => null)
      : null;
    // the funding asset is what orders actually settle in: USD, or USDT
    // after a CAD (or EUR/GBP) balance was swapped on the USDT/fiat market
    const funding = connRow ? pickFundingQuote(connRow.balances, connRow.exchange) : null;
    const spendableQuote = funding ? funding.amount : 0;
    let quoteLeft = spendableQuote;
    if (managed.conn && funding) managed.conn.quoteAsset = funding.asset;

    // ---- BTC-quoted markets, opt-in per desk. The desk keeps its USD book
    // exactly as it is; a desk with this on may also take a symbol on Kraken's
    // Bitcoin market, which is a different chart in a different currency. Those
    // trades store their prices in BTC and carry the BTC rate recorded when they
    // opened, so every dollar figure is the pair's own move translated once.
    const btcMarketsOn = (view) => view.btc_markets === true;
    const btcUsdNow =
      Number((priceMap.get("BTC") || {}).price) ||
      Number((coins.find((c) => c.symbol === "BTC") || {}).price) ||
      0;
    // the venue the BTC leg reads its charts from, and the only one it may be
    // traded on: the connected exchange resolved above. A desk with no connected
    // exchange that lists Bitcoin markets has no market to read, which is why the
    // book reports nothing instead of a board from an account it does not have.
    const btcFeed = btcVenue ? { exchange: btcVenue.exchange, testnet: btcVenue.testnet } : null;

    // ---- the account's Bitcoin, as it is now. The live Bitcoin book spends
    // it, but its only source is the balance list stored on the connection —
    // and that list is written by the account read further down this cycle, so
    // a Bitcoin bought a moment ago is not in it yet: the book then read a zero
    // balance, skipped every entry and showed none, and the desk said the
    // account held nothing. One signed read closes that gap, bounded on every
    // side: only when a desk trades the Bitcoin book, only when the stored list
    // holds no Bitcoin, only on a list older than ten minutes, and never into a
    // key in backoff. The cycle's own read refreshes the timestamp below, so
    // this can run at most once per ten minutes.
    let btcBalances = connRow && Array.isArray(connRow.balances) ? connRow.balances : [];
    const storedBalanceAgeMs =
      connRow && connRow.balance_updated_at ? Date.now() - Date.parse(connRow.balance_updated_at) : Infinity;
    if (
      managed.conn && !light && !dryRun && btcMarketsOn(liveView) &&
      pickBtcBalance(btcBalances) <= 0 && storedBalanceAgeMs > 10 * 60000 && !isBackedOff(connRow)
    ) {
      try {
        const acct = await readAccount({
          exchange: managed.conn.exchange,
          testnet: managed.conn.testnet,
          api_key: managed.conn.api_key,
          api_secret: managed.conn.api_secret,
          passphrase: managed.conn.passphrase || "",
        });
        if (acct.ok) {
          btcBalances = acct.balances || [];
          await base44.asServiceRole.entities.ExchangeConnection.update(managed.conn.id, {
            balances: keepBalances(acct.balances),
          });
        }
      } catch (err) {
        // a failed read costs the Bitcoin book this cycle, never the cycle
        console.log(`BTC balance read failed: ${String((err && err.message) || err)}`);
      }
    }

    // ---- the measured exit, opt-in per desk. The exit study replayed V3's own
    // entries under 21 exit rules: the fixed target was the single largest drag
    // on profit, and holding to the horizon with the 2xATR stop earned +7.18%,
    // +7.76% and +1.62% per trade out of sample (net of the per-pair cost
    // model) against the current bracket's +1.35%, +2.40% and -0.48%. A trade
    // opened with this on is booked with that exit's own fields and no target,
    // so the positions loop manages it exactly as it manages a V3 position —
    // the same 2xATR stop and horizon that were measured, nothing layered on.
    // Without an ATR at the entry bar it keeps the desk's own exit rather than
    // guessing a stop.
    const measuredExitFields = (row, view, entryPx) => {
      if ((view || {}).v3_exit !== true) return null;
      // a row the V3 entry gate already planned carries V3's own exit: it
      // must never be booked twice with a different stop
      if ((row || {}).v3) return null;
      // the exit study measured long entries only, and its plan puts the stop
      // below the entry: a short booked that way would be stopped out the
      // moment it opened, so a short keeps the desk's own exit
      if (String((row || {}).side) === "short") return null;
      const atr = Number(((row || {}).indicators || {}).atr) || 0;
      if (!(atr > 0) || !(Number(entryPx) > 0)) return null;
      const plan = v3Plan({ entryPx: Number(entryPx), atr });
      if (!plan) return null;
      return {
        v3_algo: true,
        v3_stop: round(plan.stop, 8),
        v3_horizon_bars: plan.horizon_bars,
        v3_atr: round(atr, 8),
      };
    };
    // live budget: how much exchange money the bot may put to work in total,
    // minus what its open real positions already hold — once the budget is
    // gone, qualifying setups stay paper instead of breaching the cap
    const liveBudgetCap = Number(lrVal("live_cap_usd", 0)) || 0;
    let liveBudget = liveBudgetCap > 0
      ? liveBudgetCap -
        openTrades
          .filter((t) => (t.mode || "paper") === "real" && quoteOf(t.quote_asset) === "USD")
          .reduce((a, t) => a + (Number(t.size_usd) || 0), 0)
      : Infinity;
    let cash = Number(config.cash_balance) || 0;
    // the paper Bitcoin book's own bankroll: sized, spent and re-anchored
    // against itself, so the two currencies can never fund one another
    const btcStart = Number(config.btc_starting_balance) || 10000;
    let btcCash = Number(config.btc_cash_balance) || btcStart;
    const closed = [];
    const positions = [];
    const pendingMarks = [];
    const sentinel = [];

    /**
     * Shared close path for bot-managed positions: sends the real sell order
     * when the position is a bot-placed real one, books the result, alerts
     * and remembers the lesson. Returns false when the exchange refused.
     */
    async function closeOut(t, side, exitPrice, reason, extraUpdates = {}, alertFor) {
      // only a real position places a sell order, but the dust note below is
      // built for every close — paper ones included. Declared out here so a
      // paper close reads null instead of throwing "sell is not defined".
      let sell = null;
      if (t.mode === "real") {
        // the scheduled desk guard can close this position between the cycle's
        // read and this close: the live row is re-read so exactly one writer
        // sends a sell — two would sell the position twice
        const fresh = await base44.asServiceRole.entities.Trade.get(t.id).catch(() => null);
        if (!fresh || fresh.status !== "open") return false;
        if (!managed.conn) {
          // never book a close the exchange has not confirmed: with live
          // trading paused or the connection unhealthy, the real position
          // stays open and one alert is raised instead of a silent paper close
          const recent = asArray(
            await base44.entities.Alert.filter(
              {
                trade_id: t.id,
                kind: "order_failed",
                created_date: { $gte: new Date(Date.now() - 30 * 60000).toISOString() },
              },
              { limit: 1 },
            ),
          );
          if (!recent.length)
            await base44.entities.Alert.create({
              symbol: t.symbol,
              title: `Cannot close ${t.symbol} right now`,
              message: managed.reason || "The exchange connection is unavailable — the position stays open.",
              mode: "live",
              kind: "order_failed",
              severity: "danger",
              trade_id: t.id,
            });
          if (Object.keys(extraUpdates).length)
            await base44.entities.Trade.update(t.id, extraUpdates);
          return false;
        }
        // a locked key needs silence to clear: signed orders placed into a
        // lockout count against it and extend the lock, so the close waits
        // out the backoff instead of hammering the exchange each cycle
        if (isBackedOff(connRow)) {
          const lockAlert = asArray(
            await base44.entities.Alert.filter(
              {
                trade_id: t.id,
                kind: "order_failed",
                created_date: { $gte: new Date(Date.now() - 30 * 60000).toISOString() },
              },
              { limit: 1 },
            ),
          );
          if (!lockAlert.length)
            await base44.entities.Alert.create({
              symbol: t.symbol,
              title: `${t.symbol} close waits out the exchange lockout`,
              message: "The exchange key is temporarily locked after failed attempts — the position stays open and closes once the lock clears.",
              mode: "live",
              kind: "order_failed",
              severity: "warning",
              trade_id: t.id,
            });
          if (Object.keys(extraUpdates).length)
            await base44.entities.Trade.update(t.id, extraUpdates);
          return false;
        }
        // a margin short closes by buying the base quantity back, not selling —
        // through the venue's margin route so the debt is repaid with it
        sell = await placeMarketOrder(managed.conn, {
          symbol: t.symbol,
          side: side === "short" ? "buy" : "sell",
          quantity: Number(t.quantity) || 0,
          // a BTC-quoted position lives on its own market: the close must sell
          // the pair it was bought on, never the dollar one of the same coin
          ...(t.quote_asset === "BTC" ? { quote: "BTC" } : {}),
          ...(side === "short" ? { margin: true, leverage: liveEngine.leverage } : {}),
        });
        // dust: the exchange can never sell this little — book the close on
        // the desk without an order instead of stranding the position
        if (!sell.ok && !sell.dust) {
          await base44.entities.Alert.create({
            symbol: t.symbol,
            title: `Could not close ${t.symbol} on ${managed.conn.label}`,
            message: sell.message,
            mode: "live",
            kind: "order_failed",
            severity: "danger",
            trade_id: t.id,
          });
          if (Object.keys(extraUpdates).length)
            await base44.entities.Trade.update(t.id, extraUpdates);
          return false;
        }
        if (sell.avg_price) exitPrice = sell.avg_price;
      }
      const entry = Number(t.entry_price) || 0;
      const qty = Number(t.quantity) || 0;
      const size = Number(t.size_usd) || 0;
      // a BTC-quoted position's entry and exit are both in BTC, so its P&L is
      // the pair's own move; the dollar figure is that move at the rate when it
      // closes. A USD position takes the same path with a factor of one.
      const closedQuote = t.quote_asset === "BTC" ? "BTC" : "USD";
      const closedFx = closedQuote === "BTC" ? btcUsdNow : 1;
      const pnlInQuote = side === "long" ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
      const pnl = toUsd(pnlInQuote, closedQuote, closedFx);
      const pnlPct = size ? (pnl / size) * 100 : 0;
      // the trade's excursion closes out with it: the exit is the last print
      // the position saw, so the run it made and the drawdown it took are whole
      // on the row the moment it closes. The cycle's own marks are folded in
      // first, so a high it made before the stop is never lost. The R multiple
      // and the hold time go with it — the two numbers a longer study reads.
      const ride = excursionOf(
        {
          ...t,
          mfe_price: extraUpdates.mfe_price ?? t.mfe_price,
          mae_price: extraUpdates.mae_price ?? t.mae_price,
        },
        side,
        exitPrice,
      );
      await base44.entities.Trade.update(t.id, {
        ...extraUpdates,
        status: "closed",
        exit_price: round(exitPrice, 8),
        pnl_usd: round(pnl),
        pnl_pct: round(pnlPct),
        ...(ride ? { mfe_price: round(ride.mfe, 8), mae_price: round(ride.mae, 8) } : {}),
        ...outcomeFields(t, pnlPct),
        closed_at: new Date().toISOString(),
        exit_reason: reason,
      });
      if ((t.mode || "paper") === "paper") {
        // a Bitcoin paper close books into the Bitcoin book's cash, never the dollar cash
        if (closedQuote === "BTC")
          btcCash += (paperBtcView.profit_mode || "compound") === "stack" ? Math.min(pnl, 0) : size + pnl;
        else cash += (config.profit_mode || "compound") === "stack" ? Math.min(pnl, 0) : size + pnl;
      }
      closed.push({
        id: t.id,
        symbol: t.symbol,
        side,
        exit_price: round(exitPrice, 8),
        pnl_usd: round(pnl),
        pnl_pct: round(pnlPct),
        exit_reason: reason,
      });
      const meta = alertFor ? alertFor(pnl, pnlPct) : {};
      const dustNote = sell && sell.dust
        ? `The exchange holds ${sell.held_qty} ${t.symbol}, below its minimum sellable amount — closed on the desk without an order. `
        : "";
      await base44.entities.Alert.create({
        symbol: t.symbol,
        title: `${t.symbol} closed ${pnl >= 0 ? "in profit" : "at a loss"} (${round(pnlPct)}%)`,
        message: dustNote + (meta.message || ""),
        mode: (t.mode || "paper") === "real" ? "live" : "paper",
        kind: meta.kind || "bot_close",
        severity: dustNote ? "warning" : pnl >= 0 ? "success" : "danger",
        trade_id: t.id,
      });
      // remember the call: its pattern now carries this result into future scans
      await recordLesson(base44, t, pnlPct, pnl, reason);
      return true;
    }

    /**
     * 3R scale-out (the pooled flat-tape winner, three 6-month windows):
     * half the position books at +3R, the runner's stop moves to break-even,
     * and the rest runs to the target. The booked leg becomes its own closed
     * trade record, so journal totals and pooled reviews match the backtest's
     * leg accounting. Returns false to keep the position whole this cycle.
     */
    async function scaleOut(t, side, scalePrice, newStop) {
      const entry = Number(t.entry_price) || 0;
      const qty = Number(t.quantity) || 0;
      const size = Number(t.size_usd) || 0;
      const halfQty = qty / 2;
      if (!(entry > 0) || !(halfQty > 0)) return false;
      if (t.mode === "real") {
        if (!managed.conn || isBackedOff(connRow)) return false;
        // the same double-writer guard a close takes: a second scale-out would
        // halve a position the guard already closed
        const fresh = await base44.asServiceRole.entities.Trade.get(t.id).catch(() => null);
        if (!fresh || fresh.status !== "open") return false;
        // half the order under the exchange minimum: stay whole and let the
        // full position close at its target instead of spamming refused orders
        // (the floor is the dollar minimum this position's size is in)
        if (!(size / 2 >= 10)) return false;
        const sell = await placeMarketOrder(managed.conn, {
          symbol: t.symbol,
          side: side === "short" ? "buy" : "sell",
          quantity: halfQty,
          // a BTC-quoted position books out on its own market
          ...(t.quote_asset === "BTC" ? { quote: "BTC" } : {}),
          ...(side === "short" ? { margin: true, leverage: liveEngine.leverage } : {}),
        });
        if (!sell.ok) return false;
        if (sell.avg_price) scalePrice = sell.avg_price;
      }
      const legQty = round(halfQty, 8);
      const legSize = round(size / 2);
      const legQuote = t.quote_asset === "BTC" ? "BTC" : "USD";
      const legFx = legQuote === "BTC" ? btcUsdNow : 1;
      const legInQuote = side === "long" ? (scalePrice - entry) * legQty : (entry - scalePrice) * legQty;
      const pnl = toUsd(legInQuote, legQuote, legFx);
      const pnlPct = legSize ? (pnl / legSize) * 100 : 0;
      // the booked leg is planted on the parent's own risk and its own run, so
      // its R and its excursion read the way the parent's would at this price
      const legRisk = Number(t.risk_pct) || riskPctAt(entry, t.stop_price);
      const legRide = excursionOf(t, side, scalePrice);
      await base44.entities.Trade.create({
        symbol: t.symbol,
        name: t.name,
        image: t.image,
        side,
        mode: t.mode || "paper",
        status: "closed",
        entry_price: round(entry, 8),
        exit_price: round(scalePrice, 8),
        quantity: legQty,
        size_usd: legSize,
        stop_price: t.stop_price,
        target_price: t.target_price,
        target_r: t.target_r,
        risk_pct: round(legRisk, 2),
        ...(legRide ? { mfe_price: round(legRide.mfe, 8), mae_price: round(legRide.mae, 8) } : {}),
        score: t.score,
        pattern: t.pattern,
        exchange: t.exchange,
        pnl_usd: round(pnl),
        pnl_pct: round(pnlPct),
        ...outcomeFields({ ...t, risk_pct: legRisk }, pnlPct),
        exit_reason: "scale",
        opened_at: t.opened_at,
        closed_at: new Date().toISOString(),
        signal_id: t.signal_id,
        rationale: "Scale-out: half booked at +3R, the runner's stop sits at break-even",
      });
      if ((t.mode || "paper") === "paper") {
        if (legQuote === "BTC")
          btcCash += (paperBtcView.profit_mode || "compound") === "stack" ? Math.min(pnl, 0) : legSize + pnl;
        else cash += (config.profit_mode || "compound") === "stack" ? Math.min(pnl, 0) : legSize + pnl;
      }
      await base44.entities.Trade.update(t.id, {
        quantity: legQty,
        size_usd: legSize,
        scaled: true,
        stop_price: round(newStop, 8),
      });
      await base44.entities.Alert.create({
        symbol: t.symbol,
        title: `${t.symbol} scaled out at +3R`,
        message: `Half the position booked at ${round(scalePrice, 8)} — P&L ${round(pnl)} USD. The runner's stop sits at break-even and keeps its target.`,
        mode: (t.mode || "paper") === "real" ? "live" : "paper",
        kind: "target_hit",
        severity: "success",
        trade_id: t.id,
      });
      await recordLesson(base44, { ...t, quantity: legQty, size_usd: legSize }, pnlPct, pnl, "scale");
      return true;
    }

    // ---- manage the positions already open
    stage = "positions";
    for (const t of dryRun ? [] : openTrades) {
      // every open trade is managed: paper or real, dollar or Bitcoin book, the
      // bot's own entry or one imported from the wallet or logged by hand. The
      // one way out is the trade's own Bot handling switch, which the user turns
      // off on its card — then it is theirs alone, and no stop, exit or
      // sentiment touches it until it is turned back on
      if (t.bot_handling === false) continue;
      const priceUsd = priceMap.get(t.symbol)?.price ?? null;
      if (!priceUsd) continue;
      // a BTC-quoted position is marked, stopped and exited on its own market:
      // its recorded levels are in BTC, so the tape is read in BTC too. A USD
      // position reads the tape as it always did.
      const posQuote = t.quote_asset === "BTC" ? "BTC" : "USD";
      const posFx = posQuote === "BTC" ? btcUsdNow : 1;
      if (!(posFx > 0)) continue;
      const price = posQuote === "BTC" ? priceUsd / posFx : priceUsd;
      if (!(price > 0)) continue;
      const side = t.side === "short" ? "short" : "long";
      let entry = Number(t.entry_price) || 0;
      if (!entry) continue;
      // each position follows its own desk's rules: real positions are live-
      // desk trades, everything else is paper
      const isRealPos = (t.mode || "paper") === "real";
      // a Bitcoin-market position follows its own book's rules, a dollar one its desk's
      const isBtcPos = posQuote === "BTC";
      const deskCfg = isBtcPos ? (isRealPos ? liveBtcView : paperBtcView) : isRealPos ? liveView : paperView;
      const deskEng = isBtcPos ? (isRealPos ? liveBtcEngine : paperBtcEngine) : isRealPos ? liveEngine : paperEngine;

      // ---- V3 positions exit on the algorithm's own rules, which are the ones
      // that were measured: a 2xATR daily stop and a 30-bar horizon, with no
      // target. The scored exits — target, break-even, trailing, scale-out,
      // pyramid and the sentiment pass — all change the tested rule, so they
      // are skipped here rather than layered on top of it.
      if (t.v3_algo === true) {
        const v3Stop = Number(t.v3_stop) || Number(t.stop_price) || 0;
        const due = v3ExitDue({
          trade: { v3_stop: v3Stop, v3_horizon_bars: t.v3_horizon_bars, opened_at: t.opened_at },
          price,
          nowMs: Date.now(),
        });
        if (due.exit) {
          const reason = due.reason;
          const ok = await closeOut(t, side, due.price, reason, {}, (pnl) => ({
            kind: reason === "stop" ? "stop_hit" : "bot_close",
            message:
              reason === "stop"
                ? `V3 stop hit at ${round(due.price, 8)} (2xATR below entry). P&L ${round(pnl)} USD.`
                : `V3 horizon reached: held ${due.days_held} daily bars, closed at ${round(due.price, 8)}. P&L ${round(pnl)} USD.`,
          }));
          if (!ok) continue;
          continue;
        }
        // still running: mark to market, and nothing else touches it. Its
        // excursion is marked with it: V3 exits on the algorithm's own rules,
        // but the run it made is still what a longer study reads, and this
        // branch leaves the loop before the batched mark below
        const v3Ride = excursionOf(t, side, price);
        if (
          v3Ride &&
          (round(v3Ride.mfe, 8) !== round(Number(t.mfe_price) || 0, 8) ||
            round(v3Ride.mae, 8) !== round(Number(t.mae_price) || 0, 8))
        )
          pendingMarks.push({
            id: t.id,
            mfe_price: round(v3Ride.mfe, 8),
            mae_price: round(v3Ride.mae, 8),
          });
        const v3Qty = Number(t.quantity) || 0;
        const v3Size = Number(t.size_usd) || 0;
        const v3InQuote = side === "long" ? (price - entry) * v3Qty : (entry - price) * v3Qty;
        const v3Unreal = toUsd(v3InQuote, posQuote, posFx);
        const v3Travelled = side === "long" ? price - entry : entry - price;
        const v3Unit = Math.abs(entry - v3Stop);
        positions.push({
          id: t.id,
          symbol: t.symbol,
          name: t.name,
          image: t.image,
          side,
          mode: t.mode || "paper",
          entry_price: entry,
          // the position's own quote: a Bitcoin-market position's entry, stop
          // and target are in BTC, so its current price is too
          current_price: round(price, 8),
          stop_price: v3Stop ? round(v3Stop, 8) : null,
          target_price: null,
          size_usd: v3Size,
          pnl_usd: round(v3Unreal),
          pnl_pct: v3Size ? round((v3Unreal / v3Size) * 100) : 0,
          progress_pct: v3Unit
            ? round(Math.max(0, Math.min(100, (v3Travelled / v3Unit) * 100)))
            : 0,
          v3: true,
          v3_days_held: due.days_held,
          v3_horizon_bars: Number(t.v3_horizon_bars) || 30,
          quote_asset: posQuote,
        });
        continue;
      }

      const gainPct =
        side === "long" ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;
      let stop = Number(t.stop_price) || (side === "long" ? entry * 0.975 : entry * 1.025);
      const target = Number(t.target_price) || 0;
      const prevPeak = Number(t.peak_price) || entry;
      let peak = prevPeak;
      const updates = {};
      // the excursion the position has covered: its best and worst price since
      // it opened, carried on from the row. Written only when it moves, so a
      // position that has not made a new extreme costs no write.
      const ride = excursionOf(t, side, price);
      if (
        ride &&
        (round(ride.mfe, 8) !== round(Number(t.mfe_price) || 0, 8) ||
          round(ride.mae, 8) !== round(Number(t.mae_price) || 0, 8))
      ) {
        updates.mfe_price = round(ride.mfe, 8);
        updates.mae_price = round(ride.mae, 8);
      }

      // engine_v2: break-even once the trade is +1.2R in — the optimizer
      // winner's protective stop move, applied before any trailing
      const targetR = Number(t.target_r) || 0;
      if (deskEng.engineV2 && targetR && target) {
        const bePct = ((Math.abs(target - entry) / targetR) / entry) * 100 * 1.2;
        if (gainPct >= bePct) {
          const be = side === "long" ? entry * 1.0005 : entry * 0.9995;
          if (side === "long" ? be > stop : be < stop) stop = be;
        }
      }

      // trailing follows the desk the position trades on: real positions
      // trail by the live rules whenever the user left trailing on there —
      // the combo engine's break-even and 4.5R target exits still run as
      // tested, and the trailing stop ratchets on top once its trigger hits.
      // The paper desk keeps the tested stacks' behavior (no trailing on
      // combo/margin targets)
      const trailingOn = isRealPos
        ? deskCfg.trailing_stop !== false
        : (Number(t.target_r) || 0) >= 3
          ? false
          : deskCfg.trailing_stop !== false;
      if (trailingOn) {
        if (side === "long" && price > peak) peak = price;
        if (side === "short" && price < peak) peak = price;
        if (gainPct >= Number(deskCfg.trailing_trigger_pct ?? 3)) {
          const dist =
            Number(deskCfg.trailing_distance_pct ?? 1.5) / 100;
          const trail = side === "long" ? peak * (1 - dist) : peak * (1 + dist);
          if (side === "long" && trail > stop) stop = trail;
          if (side === "short" && trail < stop) stop = trail;
        }
        if (peak !== prevPeak) updates.peak_price = round(peak, 8);
      }
      // the live desk's profit lock: once a trade is up by its arm threshold,
      // its stop keeps a share of the best price it reached, so a run books
      // most of itself instead of riding back to the entry stop. It is the same
      // rule the scheduled guard runs while the app is closed (see risk.ts and
      // deskGuard), and both only ever raise a stop — the higher one wins, so
      // the two can never fight. A V3 or measured-exit position returns above
      // and takes it from the guard instead.
      if (isRealPos && deskCfg.profit_lock !== false) {
        const lock = profitLock({
          side,
          entry,
          stop,
          peak,
          price,
          armPct: Number(deskCfg.lock_arm_pct ?? 2) || 0,
          givebackPct: Number(deskCfg.giveback_pct ?? 50) || 0,
        });
        if (lock) {
          if (lock.peak !== prevPeak) updates.peak_price = round(lock.peak, 8);
          peak = lock.peak;
          if (lock.raised) stop = lock.stop;
        }
      }
      if (stop !== Number(t.stop_price)) updates.stop_price = round(stop, 8);

      const hitTarget = target
        ? side === "long"
          ? price >= target
          : price <= target
        : false;
      const hitStop = side === "long" ? price <= stop : price >= stop;
      // per-trade max loss guard: a trade down more than max_trade_loss_pct
      // of its own deployed size is force-closed at market — the backstop
      // when a stop sits too wide or the tape moved past the desk's checks
      const maxLossPct = Number(deskCfg.max_trade_loss_pct) || 0;
      const hitMaxLoss = maxLossPct > 0 && gainPct <= -maxLossPct;
      // 3R scale-out: fires once, at +3R, on the stacks tested at scale-out
      // targets (6R combo). A 3R margin target coincides with its own target
      // and closes whole; break-even already protects the runner at +1.2R.
      const rUnitPct = targetR && target ? (Math.abs(target - entry) / targetR / entry) * 100 : 0;
      if (
        !hitTarget && !hitStop && !hitMaxLoss &&
        targetR >= 4 && rUnitPct && !t.scaled &&
        gainPct >= rUnitPct * 3
      ) {
        const be = side === "long" ? entry * 1.0005 : entry * 0.9995;
        const newStop = side === "long" ? Math.max(stop, be) : Math.min(stop, be);
        if (await scaleOut(t, side, price, newStop)) continue;
      }
      const exit = hitTarget || hitStop || hitMaxLoss;

      if (exit) {
        // the stop always wins: a breached stop fills at its level — the same
        // fill the backtest assumes — even when the tape gapped past it, and
        // never at the market price of a later stagnant cut. A bar that touched
        // both levels fills the stop first, the backtest's own conservative
        // rule, so a "target" exit can never book a loss.
        const exitPrice = hitStop ? stop : hitTarget ? target : price;
        const reason = hitStop
          ? updates.stop_price
            ? "trailing"
            : "stop"
          : hitMaxLoss
            ? "max_loss"
            : "target";
        const ok = await closeOut(t, side, exitPrice, reason, updates, (pnl, pnlPct) => ({
          kind: reason === "target" ? "target_hit" : "stop_hit",
          message: `${
            reason === "target"
              ? "Target reached"
              : reason === "trailing"
                ? "Trailing stop hit"
                : reason === "max_loss"
                  ? "Max loss guard: the trade reached its per-trade loss cap"
                  : "Stop hit"
          } at ${round(exitPrice, 8)}. P&L ${round(pnl)} USD.`,
        }));
        if (!ok) continue;
      } else {
        // pyramiding: a desk that opts in adds to its winners. Once a trade
        // is up by the add trigger, another leg — half the opening size —
        // joins at market and the entry becomes the weighted average, so
        // exits and P&L stay honest. Position max is twice the opening
        // size: two add legs, never after the 3R scale-out, never on a
        // manual buy. The higher entry also re-arms break-even and
        // trailing against it on the next cycle, so the added size
        // manages exactly like the opening leg.
        const addsSoFar = Number(t.adds) || 0;
        const pyramidOn = deskCfg.pyramid === true;
        // a BTC-quoted position is never added to: the leg is sized and paid
        // from the desk's dollar quote, which this position never spends, so
        // an add would size against money it cannot use
        if (
          pyramidOn && t.quote_asset !== "BTC" && t.manual !== true && !t.scaled && addsSoFar < 2 &&
          // an imported holding is not the bot's entry: it adds to its own trade only
          !(t.imported === true || t.pattern === "long/imported")
        ) {
          const trigger =
            Number(isRealPos ? lrVal("pyramid_trigger_pct", 1.5) : (config.pyramid_trigger_pct ?? 1.5)) || 1.5;
          const origSize = (Number(t.size_usd) || 0) / (1 + 0.5 * addsSoFar);
          const addSize = round(origSize * 0.5, 2);
          if (gainPct >= trigger && origSize >= 10 && addSize >= 5) {
            let ok = true;
            let fill = price;
            if (isRealPos) {
              ok = false;
              if (
                live.conn != null && liveVerified && !isBackedOff(connRow) &&
                quoteLeft >= addSize * 1.01 && liveBudget >= addSize
              ) {
                const add = await placeMarketOrder(live.conn, {
                  symbol: t.symbol,
                  side: side === "short" ? "sell" : "buy",
                  usd: addSize,
                  price,
                  ...(side === "short" ? { margin: true, leverage: deskEng.leverage } : {}),
                });
                if (add.ok) {
                  fill = add.avg_price || price;
                  liveBudget -= addSize;
                  quoteLeft -= addSize * 1.005;
                  ok = true;
                } else {
                  console.log("pyramid order refused for " + t.symbol + ": " + (add.message || "unknown"));
                }
              } else {
                console.log("pyramid skipped for " + t.symbol + ": live desk not ready or over budget");
              }
            } else {
              cash -= addSize;
            }
            if (ok) {
              const addQty = round(addSize / fill, 8);
              const newQty = round((Number(t.quantity) || 0) + addQty, 8);
              const newEntry = round(
                ((entry * (Number(t.quantity) || 0)) + fill * addQty) / newQty,
                8,
              );
              entry = newEntry;
              t.entry_price = newEntry;
              t.quantity = newQty;
              t.size_usd = round((Number(t.size_usd) || 0) + addSize, 2);
              t.adds = addsSoFar + 1;
              updates.entry_price = newEntry;
              updates.quantity = newQty;
              updates.size_usd = t.size_usd;
              updates.adds = t.adds;
              await base44.entities.Alert.create({
                symbol: t.symbol,
                title: `${t.symbol} pyramided`,
                message: `Add ${t.adds} of 2: ${round(addSize, 2)} USD joined at ${round(fill, 8)} — the position now runs ${round(t.size_usd, 2)} USD with its entry at ${round(newEntry, 8)}.`,
                mode: isRealPos ? "live" : "paper",
                kind: "bot_open",
                severity: "info",
                trade_id: t.id,
              });
            }
          }
        }

        // a surviving position the sentiment pass below re-reads
        sentinel.push(t);
        // mark-to-market writes are batched after the loop: one bulk write
        // instead of one per position keeps us under the entity rate limit
        if (Object.keys(updates).length) pendingMarks.push({ id: t.id, ...updates });
        const qty = Number(t.quantity) || 0;
        const size = Number(t.size_usd) || 0;
        const unrealInQuote = side === "long" ? (price - entry) * qty : (entry - price) * qty;
        const unreal = toUsd(unrealInQuote, posQuote, posFx);
        const travelled = side === "long" ? price - entry : entry - price;
        const goal = target ? Math.abs(target - entry) : 0;
        positions.push({
          id: t.id,
          symbol: t.symbol,
          name: t.name,
          image: t.image,
          side,
          mode: t.mode || "paper",
          entry_price: entry,
          // the position's own quote, as above: a BTC-market position reads in
          // bitcoin, a dollar one in dollars
          current_price: round(price, 8),
          stop_price: round(stop, 8),
          target_price: target,
          size_usd: size,
          pnl_usd: round(unreal),
          pnl_pct: size ? round((unreal / size) * 100) : 0,
          progress_pct: goal ? round(Math.max(0, Math.min(100, (travelled / goal) * 100))) : 0,
          quote_asset: posQuote,
        });
      }
    }

    if (pendingMarks.length)
      await base44.entities.Trade.bulkUpdate(pendingMarks.slice(0, 500));

    // signals age out: a setup older than a day is no longer actionable
    if (!light && !dryRun) {
      await base44.asServiceRole.entities.Signal
        .updateMany(
          {
            status: "new",
            detected_at: { $lt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
          },
          { $set: { status: "expired" } },
        )
        .catch(() => {});
    }

    // ---- sentiment watch: re-read every surviving position's chart so a
    // market turn is caught between stops. When the same engine that picked
    // the trade now favors the other side with conviction, the position is
    // closed (reason "flipped") and the capital is free for the next scan.
    // sentiment watch runs per desk: each desk re-reads the charts behind its
    // own open positions with its own toggle, timeframe and engine stack
    const sentimentReads = new Map(); // "desk:symbol" -> fresh analysis
    const sentimentPass = async (desk, view, trades) => {
      if (view.sentiment_watch === false || !trades.length) return;
      const moves = coins
        .map((c) => c.change24h)
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);
      const medianChange24h = moves.length ? moves[Math.floor(moves.length / 2)] : 0;
      const tf = view.timeframe || "1h";
      for (const group of chunk([...new Set(trades.map((t) => t.symbol))], 6)) {
        const settled = await Promise.allSettled(
          group.map((s) => fetchCandles(s, tf, 300)),
        );
        settled.forEach((res, i) => {
          if (res.status !== "fulfilled" || !res.value) return;
          const coin = priceMap.get(group[i]);
          if (!coin) return;
          const row = analyzeCoin(coin, res.value, {
            medianChange24h,
            dailyTargetPct: Number(view.daily_target_pct) || 2,
            barsPerDay:
              { "15m": 96, "1h": 24, "4h": 6, "12h": 2, "1d": 1, "1w": 1 / 7, "1M": 1 / 30 }[tf] || 24,
            confluenceV2: view.confluence_v2 !== false,
          });
          if (row) sentimentReads.set(`${desk}:${group[i]}`, row);
        });
      }
    };
    stage = "sentiment";
    if (!light) {
      // each book re-reads its own positions with its own sentiment settings
      const onReal = (t) => (t.mode || "paper") === "real";
      const onBtc = (t) => quoteOf(t.quote_asset) === "BTC";
      await sentimentPass("paper", paperView, sentinel.filter((t) => !onReal(t) && !onBtc(t)));
      await sentimentPass("paperbtc", paperBtcView, sentinel.filter((t) => !onReal(t) && onBtc(t)));
      await sentimentPass("live", liveView, sentinel.filter((t) => onReal(t) && !onBtc(t)));
      await sentimentPass("livebtc", liveBtcView, sentinel.filter((t) => onReal(t) && onBtc(t)));
    }
    for (const t of sentinel) {
      // manual buys trade the sell logic only: stops, targets and trailing —
      // never a sentiment flip or a thesis-decay close
      if (t.manual === true) continue;
      const row = sentimentReads.get(`${(t.mode || "paper") === "real" ? "live" : "paper"}${quoteOf(t.quote_asset) === "BTC" ? "btc" : ""}:${t.symbol}`);
      if (!row) continue;
      const side = t.side === "short" ? "short" : "long";
      const flipped =
        side === "long"
          ? row.side === "short" && row.score >= 65
          : row.side === "long" && row.score >= 65;
      // thesis decay: an underwater trade whose fresh read barely still
      // supports its own side is closed instead of drifting down to the stop
      const ownScore = side === "long" ? row.long_score : row.short_score;
      const livePrice = Number(priceMap.get(t.symbol)?.price) || 0;
      // the thesis check compares like with like: a Bitcoin position's price is in bitcoin
      const livePriceQuote = toQuote(livePrice, t.quote_asset, btcUsdNow);
      const entryPrice = Number(t.entry_price) || 0;
      const weakened =
        entryPrice && livePriceQuote
          ? (side === "long" ? livePriceQuote < entryPrice : livePriceQuote > entryPrice) &&
            ownScore != null &&
            ownScore < 45
          : false;
      if (!flipped && !weakened) continue;
      const flipUsd = Number(row.price) || livePrice || 0;
      if (!flipUsd) continue;
      // the fresh read is priced in USD; a BTC-quoted position closes on its own
      // market, so the price it closes at is the pair's
      const flipQuote = t.quote_asset === "BTC" ? "BTC" : "USD";
      const flipFx = flipQuote === "BTC" ? btcUsdNow : 1;
      const flipPrice = flipQuote === "BTC" ? (flipFx > 0 ? flipUsd / flipFx : 0) : flipUsd;
      if (!(flipPrice > 0)) continue;
      const reason = flipped ? "flipped" : "weakened";
      const trailing = pendingMarks.find((m) => m.id === t.id);
      const ok = await closeOut(t, side, flipPrice, reason, trailing || {}, (pnl, pnlPct) => ({
        kind: "bot_close",
        message: flipped
          ? `Sentiment flipped on the ${config.timeframe || "1h"} chart: the read now favors ${row.side} (score ${row.score}). Closed at ${round(flipPrice, 8)}. P&L ${round(pnl)} USD.`
          : `Thesis weakened on the ${config.timeframe || "1h"} chart: the ${side} read fell to ${ownScore} while the trade is underwater. Closed at ${round(flipPrice, 8)}. P&L ${round(pnl)} USD.`,
      }));
      if (ok) {
        const idx = pendingMarks.findIndex((m) => m.id === t.id);
        if (idx >= 0) pendingMarks.splice(idx, 1);
      }
    }

    // ---- look for new entries. The two desks qualify setups by their own
    // rules: the live leg scores against the live rules and fires real
    // orders, the paper leg trades the paper rules with paper cash. The
    // scan itself stays shared — one board, two rule sets read from it.
    const closedIds = new Set(closed.map((c) => c.id));
    const stillOpen = openTrades.filter((t) => !closedIds.has(t.id));
    // each currency is its own book on its desk. The dollar counts below are
    // the dollar book's, and the Bitcoin book counts itself: a BTC position
    // never takes a dollar slot, and a dollar position never fills one.
    const liveOpenCount = stillOpen.filter((t) => (t.mode || "paper") === "real" && quoteOf(t.quote_asset) === "USD").length;
    const paperOpenCount = stillOpen.filter((t) => (t.mode || "paper") === "paper" && quoteOf(t.quote_asset) === "USD").length;
    const liveBtcOpen = stillOpen.filter((t) => (t.mode || "paper") === "real" && quoteOf(t.quote_asset) === "BTC").length;
    const paperBtcOpen = stillOpen.filter((t) => (t.mode || "paper") === "paper" && quoteOf(t.quote_asset) === "BTC").length;
    const openCount = stillOpen.length;
    const paperMaxOpen = Math.max(1, Number(config.max_open_positions) || 8);
    const liveMaxOpen = Math.max(1, Number(lrVal("max_open_positions", 8)) || 8);
    // each Bitcoin book's own slots
    const paperBtcMaxOpen = Math.max(1, Number(paperBtcView.max_open_positions) || 8);
    const liveBtcMaxOpen = Math.max(1, Number(liveBtcView.max_open_positions) || 8);
    const opened = [];
    const proposed = [];
    let eligibleCount = null;
    const deskDiag = {};
    let board = { rows: [], scannedCount: 0, universeCount: coins.length, summary: null, medianChange24h: 0, source: "cache" };
    let scanLog = null;
    let v3Summary = null;
    // the Bitcoin market's own board and V3 read, declared at the cycle's own
    // scope so the response can report them whether or not the scan ran
    let btcBoard = null;
    // the live Bitcoin book's own board, when its scan settings differ
    let liveBtcBoard = null;
    let btcV3Summary = null;
    // BTC's own daily trend as the V3 gate read it this cycle: copied onto
    // every trade opened under it, so a closed setup can be read in the market
    // it actually lived in rather than in today's
    let btcAbove200d = null;
    // Bitcoin's share of the board and which way it moved over the day, as
    // this cycle read it. Declared here so the response reports it whether or
    // not the entry block ran — a light cycle reads no board and leaves it null
    let dominance = null;
    // why the live Bitcoin book could not open an entry this pass — the desk
    // shows this line instead of leaving a book that never trades unexplained
    let btcBlocked = null;
    // portfolio risk state for the paper desk: filled in when this cycle
    // actually looks for entries, surfaced in the response for the bot page
    let paperRisk = null;
    // the paper Bitcoin book's own brakes, computed from its own trades
    let btcRisk: any = null;
    // the guarded stages' failure reasons, reported for the page. They are
    // declared here, not inside the scan block below, because the cycle's
    // response reads them whether or not that block ran: a light cycle — the
    // desk's cheap refresh — skips the block, so the read threw
    // "riskError is not defined" and took the whole call down with a 500.
    let riskError = null;
    let v3Error = null;

    const scanGateOpen =
      paperOpenCount < paperMaxOpen ||
      (btcMarketsOn(paperView) && paperBtcOpen < paperBtcMaxOpen) ||
      (live.conn != null && liveVerified &&
        (liveOpenCount < liveMaxOpen || (btcMarketsOn(liveView) && liveBtcOpen < liveBtcMaxOpen)));

    stage = "scan";
    if (!light && config.mode !== "off" && scanGateOpen && !cycleInFlight && (dryRun || claimConfirmed)) {
      const watch = asArray(await base44.entities.Watchlist.list({ limit: 60 }));
      // when real orders are on, only scan coins the connected exchange
      // actually lists — anything else could never be bought there
      // scan only markets the account's funding currency can actually settle
      const listed = live.conn ? await fetchListedSymbols(live.conn, funding ? [funding.asset] : null) : null;
      if (listed) eligibleCount = listed.size;
      // a symbol whose order just failed is left alone for an hour: every
      // refused signed order still counts toward the exchange's temporary
      // lockout, so re-firing into the same refusal each cycle never happens
      const failedRecently = asArray(
        await base44.entities.Alert.filter(
          {
            created_by_id: config.created_by_id,
            kind: "order_failed",
            mode: "live",
            created_date: { $gte: new Date(Date.now() - 60 * 60000).toISOString() },
          },
          { limit: 50 },
        ),
      ).map((a) => a.symbol);
      board = await scanBoard({
        timeframe: config.timeframe || "1h",
        scope: config.market_cap_scope || "all",
        count: 60,
        dailyTargetPct: Number(config.daily_target_pct) || 2,
        extraSymbols: watch.map((w) => w.symbol),
        ...(listed ? { onlySymbols: listed } : {}),
        confluenceV2: config.confluence_v2 !== false,
        feed: scanVenue,
      });
      // the live desk scans its own board when its scan settings differ from
      // the paper desk's — separate desks, separate scans; matching settings
      // share one board so the cycle never scans the market twice needlessly
      const liveScanDiffers =
        String(liveView.timeframe || "1h") !== String(config.timeframe || "1h") ||
        String(liveView.market_cap_scope || "all") !== String(config.market_cap_scope || "all") ||
        (liveView.confluence_v2 !== false) !== (config.confluence_v2 !== false);
      let liveBoard = board;
      if (live.conn != null && liveVerified && liveScanDiffers) {
        liveBoard = await scanBoard({
          timeframe: liveView.timeframe || "1h",
          scope: liveView.market_cap_scope || "all",
          count: 60,
          dailyTargetPct: Number(lrVal("daily_target_pct", 2)) || 2,
          extraSymbols: watch.map((w) => w.symbol),
          ...(listed ? { onlySymbols: listed } : {}),
          confluenceV2: liveView.confluence_v2 !== false,
          feed: scanVenue,
        });
      }

      // ---- the BTC-quoted board: Kraken's Bitcoin markets, scanned by the same
      // engine, so the desk's own tools read them — the same score gates, the
      // same V3 daily gates, the same top-pick option, the same exits. A BTC
      // pair's levels are in bitcoin, which is what its position, stop, target
      // and fills work in; its dollar figures come through the rate recorded at
      // the cycle. One board answers both desks, because the scan settings are
      // the desk's own and the bars ignore the desk.
      const btcBoardWanted =
        btcFeed != null && btcUsdNow > 0 && (btcMarketsOn(paperView) || btcMarketsOn(liveView));
      if (btcBoardWanted) {
        try {
          // the Bitcoin venue lists the pairs this book can hold: reading them
          // from the live account instead would filter a Kraken market by a
          // listing Kraken never published
          const btcListed = btcVenue ? await fetchListedSymbols(btcVenue, ["BTC"]) : null;
          btcBoard = await scanBoard({
            timeframe: paperBtcView.timeframe || "1h",
            scope: paperBtcView.market_cap_scope || "all",
            count: 60,
            dailyTargetPct: Number(paperBtcView.daily_target_pct) || 2,
            extraSymbols: watch.map((w) => w.symbol),
            // an empty set means the listing read found nothing, not that
            // nothing is listed: honouring it would blank the whole book
            ...(btcListed && btcListed.size ? { onlySymbols: btcListed } : {}),
            confluenceV2: paperBtcView.confluence_v2 !== false,
            feed: btcFeed,
            quote: "BTC",
            btcUsd: btcUsdNow,
          });
        } catch (err) {
          // a BTC board failure costs the BTC book, never the cycle
          btcBoard = null;
          console.log(`BTC market board failed: ${String((err && err.message) || err)}`);
        }
      }

      // the live Bitcoin book scans its own board when its scan settings differ
      // from the paper Bitcoin book's; matching settings share one board
      const btcSameScan = (a, b) =>
        String(a.timeframe || "1h") === String(b.timeframe || "1h") &&
        String(a.market_cap_scope || "all") === String(b.market_cap_scope || "all") &&
        (a.confluence_v2 !== false) === (b.confluence_v2 !== false) &&
        (Number(a.daily_target_pct) || 2) === (Number(b.daily_target_pct) || 2);
      liveBtcBoard = btcBoard;
      if (btcBoard && liveBtcVenue && liveVerified && btcMarketsOn(liveView) && !btcSameScan(paperBtcView, liveBtcView)) {
        try {
          const liveBtcListed = await fetchListedSymbols(btcVenue, ["BTC"]);
          liveBtcBoard = await scanBoard({
            timeframe: liveBtcView.timeframe || "1h",
            scope: liveBtcView.market_cap_scope || "all",
            count: 60,
            dailyTargetPct: Number(liveBtcView.daily_target_pct) || 2,
            extraSymbols: watch.map((w) => w.symbol),
            ...(liveBtcListed && liveBtcListed.size ? { onlySymbols: liveBtcListed } : {}),
            confluenceV2: liveBtcView.confluence_v2 !== false,
            feed: btcFeed,
            quote: "BTC",
            btcUsd: btcUsdNow,
          });
        } catch (err) {
          liveBtcBoard = null;
          console.log(`BTC live board failed: ${String((err && err.message) || err)}`);
        }
      }

      // cooldowns are per desk: each desk leaves its own closed trades alone
      // for its own cooldown, both with the 30-minute churn floor that keeps
      // a trade the stagnant rule just cut from being re-entered at once
      const reentryMs = 30 * 60000;
      const paperCooldownMs = (Number(config.cooldown_minutes) || 120) * 60000;
      const liveCooldownMs = (Number(lrVal("cooldown_minutes", 120)) || 120) * 60000;
      const paperBtcCooldownMs = (Number(paperBtcView.cooldown_minutes) || 120) * 60000;
      const liveBtcCooldownMs = (Number(liveBtcView.cooldown_minutes) || 120) * 60000;
      const since = new Date(Date.now() - Math.max(paperCooldownMs, liveCooldownMs, paperBtcCooldownMs, liveBtcCooldownMs, reentryMs)).toISOString();
      const recent = await readAll({ closed_at: { $gte: since } });
      // proposals block their symbol while pending — but only fresh ones:
      // proposals left over from an approve-mode era (never acted on) blocked
      // their symbols forever and silently killed re-entries on both desks
      const pending = (await readAll({ status: "proposed" })).filter(
        (t) => (t.created_date || "") >= new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      );
      // proposals block their own desk only: a live proposal must not freeze the
      // paper desk's symbol, and the other way around
      const pendingLive = pending
        .filter((t) => (t.mode || "paper") === "real")
        .map((t) => t.symbol);
      const pendingPaper = pending
        .filter((t) => (t.mode || "paper") !== "real")
        .map((t) => t.symbol);
      const blockedLive = new Set([
        ...stillOpen.filter((t) => (t.mode || "paper") === "real").map((t) => t.symbol),
        ...recent
          .filter((t) => {
            if ((t.mode || "paper") !== "real") return false;
            const closedMs = t.closed_at ? Date.parse(t.closed_at) : 0;
            const window = t.exit_reason === "time" ? reentryMs : liveCooldownMs;
            return Date.now() - closedMs < window;
          })
          .map((t) => t.symbol),
        ...pendingLive,
        ...failedRecently,
      ]);
      const blockedPaper = new Set([
        ...stillOpen.filter((t) => (t.mode || "paper") === "paper").map((t) => t.symbol),
        ...recent
          .filter((t) => {
            if ((t.mode || "paper") === "real") return false;
            const closedMs = t.closed_at ? Date.parse(t.closed_at) : 0;
            const window = t.exit_reason === "time" ? reentryMs : paperCooldownMs;
            return Date.now() - closedMs < window;
          })
          .map((t) => t.symbol),
        ...pendingPaper,
      ]);
      // the Bitcoin book keeps its own cooldowns, its own proposals and its own
      // blocked symbols: a dollar close on a coin says nothing about its Bitcoin
      // market, and the other way round
      const blockedLiveBtc = new Set([
        ...stillOpen
          .filter((t) => (t.mode || "paper") === "real" && quoteOf(t.quote_asset) === "BTC")
          .map((t) => t.symbol),
        ...recent
          .filter((t) => {
            if ((t.mode || "paper") !== "real" || quoteOf(t.quote_asset) !== "BTC") return false;
            const closedMs = t.closed_at ? Date.parse(t.closed_at) : 0;
            const window = t.exit_reason === "time" ? reentryMs : liveBtcCooldownMs;
            return Date.now() - closedMs < window;
          })
          .map((t) => t.symbol),
        ...pending
          .filter((t) => (t.mode || "paper") === "real" && quoteOf(t.quote_asset) === "BTC")
          .map((t) => t.symbol),
        ...failedRecently,
      ]);
      const blockedPaperBtc = new Set([
        ...stillOpen
          .filter((t) => (t.mode || "paper") === "paper" && quoteOf(t.quote_asset) === "BTC")
          .map((t) => t.symbol),
        ...recent
          .filter((t) => {
            if ((t.mode || "paper") === "real" || quoteOf(t.quote_asset) !== "BTC") return false;
            const closedMs = t.closed_at ? Date.parse(t.closed_at) : 0;
            const window = t.exit_reason === "time" ? reentryMs : paperBtcCooldownMs;
            return Date.now() - closedMs < window;
          })
          .map((t) => t.symbol),
        ...pending
          .filter((t) => (t.mode || "paper") !== "real" && quoteOf(t.quote_asset) === "BTC")
          .map((t) => t.symbol),
      ]);

      // trading style bends the rules without touching what the user saved:
      // timid waits for stronger setups with less at stake, aggressive
      // accepts more setups and stakes more to reach the goal faster
      // trading style bends each desk's rules without touching what the user
      // saved: timid waits for stronger setups with less at stake, aggressive
      // accepts more setups and stakes more to reach the goal faster
      const styleRiskFor = (style) => (style === "timid" ? 0.75 : style === "aggressive" ? 1.4 : 1);
      // BTC's 24h tape drives the combo regime gate (risk-off longs, flat-tape skips)
      const btcChange = (coins.find((c) => c.symbol === "BTC") || {}).change24h ?? null;
      // Bitcoin's share of the board, and which way it moved over the last day,
      // read from the market caps the scan already carries. The reading is kept
      // on the desk so tomorrow's cycle has something to measure against; a dry
      // run writes nothing, and a venue feed carries no caps at all.
      dominance = await readDominance(dryRun ? null : base44.asServiceRole, coins);
      const rulesByDesk = {
        live: entryRulesFor(liveView, "live", btcChange),
        paper: entryRulesFor(paperView, "paper", btcChange),
      };
      // the Bitcoin books' own entry rules, read from their own views
      const btcRulesByDesk = {
        live: entryRulesFor(liveBtcView, "live", btcChange),
        paper: entryRulesFor(paperBtcView, "paper", btcChange),
      };
      const entryGate = (r, desk) => gateReasonShared(r, desk, rulesByDesk[desk]);
      const liveSlots = Math.max(1, liveMaxOpen - liveOpenCount);
      // ---- portfolio risk controls (shared/risk.ts). Everything here is a
      // restriction: a drawdown brake, a daily loss halt, a losing-streak
      // reduction and a concentration cap, computed from the paper desk's own
      // closed trades. The live desk keeps its existing caps (live_cap_usd and
      // the per-trade loss guard): it has no stored equity baseline, so a
      // drawdown measured there would be measuring nothing. Wiring it needs
      // one, and that is a separate change.
      //
      // A failure here must not kill the cycle: it fails closed instead —
      // no new paper entries — and the reason is returned for the page.
      riskError = null;
      try {
        const riskWindow = await readAll({
          status: "closed",
          closed_at: { $gte: new Date(Date.now() - 180 * 86400000).toISOString() },
        });
        const paperClosed = riskWindow
          .filter((t) => (t.mode || "paper") === "paper" && quoteOf(t.quote_asset) === "USD")
          .sort((a, b) => String(b.closed_at || "").localeCompare(String(a.closed_at || "")));
        const btcClosed = riskWindow
          .filter((t) => (t.mode || "paper") === "paper" && quoteOf(t.quote_asset) === "BTC")
          .sort((a, b) => String(b.closed_at || "").localeCompare(String(a.closed_at || "")));
        const riskDayStart = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
        // one function, run over one book's trades and one book's bankroll: a
        // dollar drawdown can not stop a Bitcoin entry, or the other way round
        const bookState = (rows, bookStart, quote) =>
          riskState({
            starting_balance: bookStart,
            realized_pnl_total: rows.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0),
            realized_pnl_today: rows
              .filter((t) => t.closed_at && Date.parse(t.closed_at) >= riskDayStart)
              .reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0),
            open_size_usd: stillOpen
              .filter((t) => (t.mode || "paper") === "paper" && quoteOf(t.quote_asset) === quote)
              .reduce((a, t) => a + (Number(t.size_usd) || 0), 0),
            losing_streak: losingStreak(rows),
          });
        paperRisk = bookState(paperClosed, Number(config.starting_balance) || 10000, "USD");
        btcRisk = bookState(btcClosed, btcStart, "BTC");
      } catch (err) {
        riskError = String((err && err.message) || err);
        console.log(`risk check failed: ${riskError}`);
        // both books fail closed: a risk read that broke can not be trusted to
        // size anything, in either currency
        paperRisk = {
          size_multiplier: 0,
          block_entries: true,
          reason: `risk check failed (${riskError})`,
          drawdown_pct: 0,
          realized_pnl_today: 0,
          losing_streak: 0,
          deployed_usd: 0,
        };
        btcRisk = { ...paperRisk };
      }
      const riskPct = Math.min(
        25,
        (Number(paperView.risk_per_trade_pct) || 4) * styleRiskFor(paperView.trading_style || "mild"),
      ) * (paperRisk.block_entries ? 0 : paperRisk.size_multiplier);

      // the paper Bitcoin book sizes from its own risk and its own brakes, so a
      // dollar drawdown never shrinks a Bitcoin entry, or the other way round
      const btcRiskPct = Math.min(
        25,
        (Number(paperBtcView.risk_per_trade_pct) || 4) * styleRiskFor(paperBtcView.trading_style || "mild"),
      ) * (btcRisk.block_entries ? 0 : btcRisk.size_multiplier);

      // self-teaching: past results per pattern (side x cap tier) nudge scores
      const lessons = await loadLessons(base44);
      const lessonMap = new Map(lessons.map((l) => [l.pattern, l]));

      // smart money: where the top on-chain traders are positioned nudges
      // scores the same way — aligned with their flow, capped at +-5 points
      const smartBias = await loadSmartBias(base44);

      const applyEdges = (rows, quote = "USD") => rows.map((r) => {
        const adj = lessonMap.get(patternFor(r.side, r.market_cap_bucket, quote))?.adj || 0;
        let smartAdj = 0;
        let smartNote = null;
        const smart = smartBias.get(r.symbol);
        if (smart) {
          const total = (smart.long_usd || 0) + (smart.short_usd || 0);
          if (total > 0) {
            const longShare = (smart.long_usd || 0) / total;
            smartAdj = Math.max(-5, Math.min(5, Math.round((longShare - 0.5) * 20)));
            if (r.side !== "long") smartAdj = -smartAdj;
            if (Math.abs(smartAdj) >= 2) {
              const sharePct = Math.round(Math.max(longShare, 1 - longShare) * 100);
              const dir = longShare >= 0.5 ? "long" : "short";
              smartNote = `Smart money net ${dir}: ${sharePct}% of top-trader open size`;
            }
          }
        }
        const scoreAdj = adj + smartAdj;
        const reasons = smartNote && (r.reasons || []).length ? [...r.reasons, smartNote] : r.reasons;
        return scoreAdj || smartNote ? { ...r, score: r.score + scoreAdj, reasons } : r;
      });
      const tradable = applyEdges(board.rows);
      const tradableLive = liveBoard === board ? tradable : applyEdges(liveBoard.rows);
      // the Bitcoin board's rows take the same score nudges, read from their
      // own book: decisive candles and the market-cap tiers follow the pair's
      // rank on the BTC market, and its lessons are its own
      const btcTradable = btcBoard ? applyEdges(btcBoard.rows, "BTC") : [];
      // the live Bitcoin book's rows: its own board when it scans differently,
      // and nothing at all when the live account cannot trade this market
      const btcTradableLive = !liveBtcVenue
        ? []
        : liveBtcBoard && liveBtcBoard !== btcBoard
          ? applyEdges(liveBtcBoard.rows, "BTC")
          : btcTradable;

      // engine targets: 6R from entry with the combo stack on (the pooled
      // flat-tape winner), 3R under the margin engine, 2.5R under the old
      // engine rules - always on the trade's own side, so the distance is
      // |entry - stop| measured outward. Each desk targets by its own stack.
      const engineTargetFor = (eng) => (r) => {
        const dist = (eng.targetR || 2.5) * Math.abs(r.entry - r.stop);
        return round(r.side === "long" ? r.entry + dist : r.entry - dist, 8);
      };
      const useEngineTargetFor = (eng) => eng.marginOn || eng.comboOn || (eng.engineV2 && eng.champion);
      const paperEngineTarget = engineTargetFor(paperEngine);
      const liveEngineTarget = engineTargetFor(liveEngine);
      const paperUseEngine = useEngineTargetFor(paperEngine);
      const liveUseEngine = useEngineTargetFor(liveEngine);
      const paperBtcEngineTarget = engineTargetFor(paperBtcEngine);
      const liveBtcEngineTarget = engineTargetFor(liveBtcEngine);
      const paperBtcUseEngine = useEngineTargetFor(paperBtcEngine);
      const liveBtcUseEngine = useEngineTargetFor(liveBtcEngine);
      // ---- V3 algorithm: one board, a third rule set. The daily gates are
      // read once per candidate per cycle (capped, in batches) and answer both
      // desks, because none of them depends on the desk. The candidate list is
      // every scanned symbol, not just the ones the intraday scan calls long:
      // V3 is a daily strategy and must not inherit the 1h side. When BTC's
      // daily trend cannot be read, the regime gate fails closed: no entries.
      const v3DeskOn = { live: v3On(liveView), paper: v3On(paperView) };
      const v3Evals = new Map();
      // harmonic patterns found at the price, per symbol: read from the same
      // daily bars, and only ever used to nudge a V3 setup's score
      const harmonicHits = new Map();
      v3Error = null;
      if (v3DeskOn.live || v3DeskOn.paper) {
        try {
          const candidates = new Set();
          for (const r of [...tradable, ...tradableLive]) {
            if (r.symbol) candidates.add(r.symbol);
          }
          const wanted = [...candidates].slice(0, 40);
          const btcDaily = await fetchCandles("BTC", "1d", 260, scanVenue).catch(() => null);
          const btcAbove = btcTrendUp(btcDaily);
          btcAbove200d = btcAbove;
          for (const group of chunk(wanted, 6)) {
            const settled = await Promise.allSettled(
              group.map((s) => fetchCandles(s, "1d", 260, scanVenue)),
            );
            settled.forEach((res, i) => {
              if (res.status !== "fulfilled" || !res.value) return;
              const ev = evaluateV3({
                candles: res.value,
                btcAboveSma200: btcAbove,
                profile: config.v3_profile || "loose",
              });
              v3Evals.set(group[i], ev);
              // a harmonic pattern at the price, on the same bars: no extra
              // request, and it can only move this setup's score
              const hit = detectHarmonic({ candles: res.value, atr: ev.atr });
              if (hit) harmonicHits.set(group[i], hit);
            });
          }
          const gates = { history: 0, entry_signal: 0, liquidity: 0, regime: 0, confluence: 0 };
          let entries = 0;
          for (const ev of v3Evals.values()) {
            if (ev.state === "entry") {
              entries += 1;
              continue;
            }
            const g = ev.gates || {};
            if (!g.history) gates.history += 1;
            else if (!g.entry_signal) gates.entry_signal += 1;
            else if (!g.liquidity) gates.liquidity += 1;
            else if (!g.regime) gates.regime += 1;
            else gates.confluence += 1;
          }
          v3Summary = {
            desks: v3DeskOn,
            candidates: wanted.length,
            evaluated: v3Evals.size,
            entries,
            btc_above: btcAbove,
            gates,
          };
        } catch (err) {
          // a V3 failure costs V3 entries, never the whole cycle
          v3Error = String((err && err.message) || err);
          console.log(`v3 evaluation failed: ${v3Error}`);
          v3Summary = { desks: v3DeskOn, evaluated: 0, entries: 0, error: v3Error };
        }
      }
      // ---- V3 on the Bitcoin markets: the same daily gates, read on the
      // pair's own chart. The one rule that depends on the currency is the
      // liquidity floor, so it is expressed in bitcoin — $5m of BTC-quoted
      // turnover is the same rule as $5m on the dollar book, not a different
      // one. A failure here costs BTC V3 entries, never the cycle.
      const btcV3DeskOn = {
        live: v3On(liveBtcView) && btcMarketsOn(liveView) && liveBtcVenue,
        paper: v3On(paperBtcView) && btcMarketsOn(paperView),
      };
      const btcV3Evals = new Map();
      // harmonic patterns on the Bitcoin markets' own daily bars, kept apart
      // from the dollar book's: a BTC-quoted chart is a different chart
      const btcHarmonicHits = new Map();
      btcV3Summary = null;
      if ((btcTradable.length || btcTradableLive.length) && (btcV3DeskOn.live || btcV3DeskOn.paper)) {
        try {
          const btcWanted = [...new Set([...btcTradable, ...btcTradableLive].map((r) => r.symbol).filter(Boolean))].slice(0, 40);
          const btcFloorBtc = usdInQuote(V3.min_adv_usd, "BTC", btcUsdNow);
          const btcAbove = btcTrendUp(
            await fetchCandles("BTC", "1d", 260, btcFeed).catch(() => null),
          );
          btcAbove200d = btcAbove;
          for (const group of chunk(btcWanted, 6)) {
            const settled = await Promise.allSettled(
              group.map((s) => fetchCandles(s, "1d", 260, btcFeed, "BTC")),
            );
            settled.forEach((res, i) => {
              if (res.status !== "fulfilled" || !res.value) return;
              const ev = evaluateV3({
                candles: res.value,
                btcAboveSma200: btcAbove,
                minAdvUsd: btcFloorBtc,
                profile: config.v3_profile || "loose",
              });
              btcV3Evals.set(group[i], ev);
              const hit = detectHarmonic({ candles: res.value, atr: ev.atr });
              if (hit) btcHarmonicHits.set(group[i], hit);
            });
          }
          const btcGates = { history: 0, entry_signal: 0, liquidity: 0, regime: 0, confluence: 0 };
          let btcEntries = 0;
          for (const ev of btcV3Evals.values()) {
            if (ev.state === "entry") {
              btcEntries += 1;
              continue;
            }
            const g = ev.gates || {};
            if (!g.history) btcGates.history += 1;
            else if (!g.entry_signal) btcGates.entry_signal += 1;
            else if (!g.liquidity) btcGates.liquidity += 1;
            else if (!g.regime) btcGates.regime += 1;
            else btcGates.confluence += 1;
          }
          btcV3Summary = {
            desks: btcV3DeskOn,
            candidates: btcWanted.length,
            evaluated: btcV3Evals.size,
            entries: btcEntries,
            btc_above: btcAbove,
            floor_btc: round(btcFloorBtc, 8),
            gates: btcGates,
          };
        } catch (err) {
          btcV3Evals.clear();
          btcV3Summary = {
            desks: btcV3DeskOn,
            evaluated: 0,
            entries: 0,
            error: String((err && err.message) || err),
          };
          console.log(`BTC v3 evaluation failed: ${String((err && err.message) || err)}`);
        }
      }
      // ---- harmonic patterns, as a weight only. A pattern found at the price
      // moves a V3 row's score by the same fixed amount either way: it agrees
      // with the long and the setup gains points, it points the other way and
      // the setup loses them. It never adds a candidate, never removes one and
      // never places an order — on a V3 desk the score only orders the setups
      // that V3 already accepted, so this decides who is bought first when more
      // qualify than the book has room for.
      const withHarmonic = (row, hit, on) => {
        if (!on || !hit) return row;
        const points = hit.direction === "bullish" ? HARMONIC.points : -HARMONIC.points;
        return {
          ...row,
          score: Math.max(0, Math.min(100, (Number(row.score) || 0) + points)),
          harmonic: hit,
          reasons: [
            ...(row.reasons || []),
            `${hit.direction === "bullish" ? "Bullish" : "Bearish"} ${hit.name} at ${round(hit.d, 8)} (reversal zone ${round(hit.prz[0], 8)}–${round(hit.prz[1], 8)}, ${round(hit.atr_distance, 2)} ATR from price): ${
              points > 0 ? "+" : ""
            }${points} to the score — a pattern never opens a trade on its own`,
          ],
        };
      };
      // ---- BTC dominance, as a weight only. Bitcoin's share of the board is
      // the axis the alts trade on: money leaving Bitcoin is money arriving in
      // them, and money going back to Bitcoin leaves them. So a long gains the
      // fixed points while the share falls and loses them while it climbs, and
      // a short is the same trade the other way round. It never adds a
      // candidate, never removes one and never places an order: on a scored desk
      // the score only orders the setups the gates already accepted, so this
      // decides who is bought first when more qualify than the book has room
      // for. Nothing here has been measured on the record yet, so it is a
      // weight rather than a gate, and a desk can turn it off.
      const dominancePts = dominance ? Number(dominance.points) || 0 : 0;
      const withDominance = (row, view) => {
        if (!dominancePts || !view || view.dominance === false) return row;
        // Bitcoin is not an alt against itself: its own score is its own
        if (String(row.symbol || "").toUpperCase() === "BTC") return row;
        const long = row.side !== "short";
        const points = long ? dominancePts : -dominancePts;
        const falling = Number(dominance.change_24h) < 0;
        return {
          ...row,
          score: Math.max(0, Math.min(100, (Number(row.score) || 0) + points)),
          dominance: {
            pct: dominance.pct,
            change_24h: dominance.change_24h,
            points,
          },
          reasons: [
            ...(row.reasons || []),
            `BTC dominance ${round(dominance.pct, 2)}%, ${falling ? "down" : "up"} ${Math.abs(
              round(dominance.change_24h, 2),
            )} points in 24h: ${points > 0 ? "+" : ""}${points} to the score — ${
              long
                ? "alts travel better while Bitcoin's share falls"
                : "a short travels better while Bitcoin's share climbs"
            }. A weight on the order setups are taken in, never a signal on its own`,
          ],
        };
      };
      // a V3 row trades the algorithm's own plan: its stop, no target, and it
      // is a long whatever the intraday scan said
      // V3 only rewrites a row on a desk that runs V3. The evaluations are
      // shared (they are daily reads that ignore the desk), but the plan is not:
      // without this guard a paper-only V3 switch would rewrite the live desk's
      // entries as V3 longs.
      const withV3 = (row, desk) => {
        if (!v3DeskOn[desk]) return row;
        const ev = v3Evals.get(row.symbol);
        if (!ev || ev.state !== "entry") return row;
        const plan = v3Plan({ entryPx: row.entry, atr: ev.atr });
        if (!plan) return row;
        const formation = ev.formations.length ? ` with ${ev.formations.join(", ")}` : "";
        const next = {
          ...row,
          side: "long",
          stop: round(plan.stop, 8),
          target: null,
          required_move_pct: null,
          v3: ev,
          reasons: [
            ...(row.reasons || []),
            `V3: ${ev.entry_signal.join(" + ")}${formation} on the daily close, stop 2xATR, no target, ${ev.horizon_bars}-bar horizon`,
          ],
        };
        // the pattern is that book's own switch
        return withHarmonic(next, harmonicHits.get(row.symbol), (desk === "live" ? liveView : paperView).harmonics === true);
      };
      const qualifies = (r, desk) => {
        const blocked = desk === "live" ? blockedLive : blockedPaper;
        if (blocked.has(r.symbol)) return false;
        // the paper desk's risk brakes come before any setup is considered
        if (desk === "paper" && paperRisk && paperRisk.block_entries) return false;
        if (v3DeskOn[desk]) {
          // the researched gates replace the score bar and the intraday side on
          // this desk; the plan must also produce a usable stop
          const ev = v3Evals.get(r.symbol);
          if (!ev || ev.state !== "entry") return false;
          return v3Plan({ entryPx: r.entry, atr: ev.atr }) != null;
        }
        return entryGate(r, desk) === null;
      };
      // the Bitcoin book runs the same two entry paths as the dollar book: the
      // desk's scored gates, or its V3 plan when the desk runs V3. Cooldowns,
      // risk brakes, blocked symbols and slots are the desk's own, so a coin
      // already held — in either currency — is left alone.
      const btcQualifies = (r, desk) => {
        // the Bitcoin book's own blocked symbols and its own brakes: a dollar
        // cooldown or a dollar drawdown never reaches this side
        const blocked = desk === "live" ? blockedLiveBtc : blockedPaperBtc;
        if (blocked.has(r.symbol)) return false;
        if (desk === "paper" && btcRisk && btcRisk.block_entries) return false;
        if (btcV3DeskOn[desk]) {
          const ev = btcV3Evals.get(r.symbol);
          if (!ev || ev.state !== "entry") return false;
          return v3Plan({ entryPx: r.entry, atr: ev.atr }) != null;
        }
        return gateReasonShared(r, desk, btcRulesByDesk[desk]) === null;
      };
      const btcWithV3 = (row, desk) => {
        if (!btcV3DeskOn[desk]) return row;
        const ev = btcV3Evals.get(row.symbol);
        if (!ev || ev.state !== "entry") return row;
        const plan = v3Plan({ entryPx: row.entry, atr: ev.atr });
        if (!plan) return row;
        const formation = ev.formations.length ? ` with ${ev.formations.join(", ")}` : "";
        const next = {
          ...row,
          side: "long",
          stop: round(plan.stop, 8),
          target: null,
          required_move_pct: null,
          v3: ev,
          reasons: [
            ...(row.reasons || []),
            `V3 on the BTC market: ${ev.entry_signal.join(" + ")}${formation}, 2xATR stop, no target, ${ev.horizon_bars}-bar horizon`,
          ],
        };
        // the pattern is that book's own switch, read on the pair's own chart
        return withHarmonic(
          next,
          btcHarmonicHits.get(row.symbol),
          (desk === "live" ? liveBtcView : paperBtcView).harmonics === true,
        );
      };
      // a live short is a margin order: only a venue whose margin API the desk
      // can place through may take one, so a spot-only account is never handed
      // a setup it would fill as a plain sell
      const liveShorts = live.conn ? SHORT_VENUES.has(live.conn.exchange) : false;
      // ---- always-take top picks: a desk can opt into buying its highest
      // scoring coins whether or not they clear the entry gates. Only entry
      // quality is bypassed: the row keeps its own stop, target and trailing,
      // and the desk's risk sizing, cooldowns, open-position guard, slot limit,
      // exchange listing filter, approve mode and paper risk brakes all still
      // apply. A desk running V3 does not mix in top picks.
      const topCount = (view) => Math.max(1, Math.min(10, Number(view.always_take_count) || 5));
      // a Bitcoin book's picks use its own blocked set, its own open positions
      // and its own shorts setting; the dollar book's picks are unchanged
      const topPicksFor = (rows, desk, count, exclude, btc = false) => {
        const blocked = btc
          ? (desk === "live" ? blockedLiveBtc : blockedPaperBtc)
          : (desk === "live" ? blockedLive : blockedPaper);
        const view = btc
          ? (desk === "live" ? liveBtcView : paperBtcView)
          : (desk === "live" ? liveView : paperView);
        const openSymbols = new Set(
          stillOpen.filter((t) => !btc || quoteOf(t.quote_asset) === "BTC").map((t) => t.symbol),
        );
        if (exclude) for (const symbol of exclude) openSymbols.add(symbol);
        return pickTopPicks(rows, {
          blocked,
          openSymbols,
          allowShorts: desk === "live"
            ? liveShorts && view.allow_shorts !== false
            : view.allow_shorts !== false,
          count,
          // wait for a good entry into the pick rather than chasing it
          requireEntry: true,
        });
      };
      const liveReady = live.conn && liveVerified && !isBackedOff(connRow);
      const liveGated = liveReady
        ? tradableLive
            .filter((r) => qualifies(r, "live") && (v3DeskOn.live || r.side === "long" || liveShorts))
            .map((r) => withV3(r, "live"))
        : [];
      const liveTop = liveReady && liveView.always_take_top === true && !v3DeskOn.live
        ? topPicksFor(tradableLive, "live", topCount(liveView))
        : [];
      const liveWanted = [...liveGated, ...liveTop]
        .filter((r, index, all) => all.findIndex((x) => x.symbol === r.symbol) === index)
        // the pattern and the tape weights are applied here, then the best score
        // goes first: they decide which setups are taken when more qualify than
        // the book has room for
        .map((r) => withDominance(r, liveView))
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
        .slice(0, Math.max(0, liveMaxOpen - liveOpenCount));
      // a desk with qualifying setups but nothing to pay with should say so
      // once (throttled), instead of firing order attempts into a wall of
      // exchange-side insufficient-funds failures every cycle
      if (!dryRun && live.conn && liveWanted.length && spendableQuote < 10) {
        const recent = asArray(
          await base44.entities.Alert.filter(
            {
              created_by_id: config.created_by_id,
              kind: "order_failed",
              mode: "live",
              created_date: { $gte: new Date(Date.now() - 30 * 60000).toISOString() },
            },
            { limit: 1 },
          ),
        );
        if (!recent.length)
          await base44.entities.Alert.create({
            symbol: liveWanted[0].symbol,
            title: `No spendable quote currency on ${live.conn.label}`,
            message: `${liveWanted.length} qualifying setup(s) skipped — the account holds no funds in a currency its orders settle in. Deposit the native quote currency, or use the convert button on the connection card, to enable live buys.`,
            mode: "live",
            kind: "order_failed",
            severity: "danger",
          });
      }
      const gateReason = entryGate;
      const constraints = live.conn ? await fetchMarketConstraints(live.conn) : null;
      // trade from the live tape: refresh the wanted symbols' prices so real
      // order sizing and target placement use the current price, not the
      // snapshot the scan ran on
      const livePx = await fetchLivePrices([...new Set(liveWanted.map((r) => r.symbol))]);
      const atLive = (r) => {
        const px = Number(livePx.get(r.symbol)) || 0;
        return px > 0 ? { ...r, entry: px } : r;
      };
      // the live Bitcoin book's own risk per trade and style
      const btcLiveRiskPct = Math.min(
        25,
        (Number(liveBtcView.risk_per_trade_pct) || 4) * styleRiskFor(liveBtcView.trading_style || "mild"),
      );
      const minimumFor = (r) => entryMinimum(constraints, r.symbol, funding?.asset || QUOTE_ASSET[live.conn?.exchange] || "USDT", r.entry);
      const liveRiskPct = Math.min(
        25,
        (Number(lrVal("risk_per_trade_pct", 4)) || 4) * styleRiskFor(liveView.trading_style || "mild"),
      );
      const sizeLive = (r, slots) => liveEntrySize({ row: r, balance: quoteLeft, budget: liveBudget, slots,
        riskPct: liveRiskPct, minimum: minimumFor(r) });
      // claim only what the live desk can actually pay for: size each wanted
      // setup the way the entry loop will, so setups live cannot afford fall
      // through to the paper desk instead of being claimed and dropped. The
      // old pre-claim starved the paper desk of every qualifying setup the
      // moment live trading was ready but the budget was small.
      const livePlans = [];
      if (live.conn && liveVerified && !isBackedOff(connRow) && liveBudget >= 10 && spendableQuote >= 10) {
        let simBudget = liveBudget;
        let simQuote = quoteLeft;
        for (const r of liveWanted) {
          if (stillOpen.some((t) => t.symbol === r.symbol)) continue;
          // sized on the stop the trade will actually carry, so the measured
          // exit's wider stop is priced into the plan (see the entry loop)
          const planned = measuredExitFields(r, liveView, r.entry);
          const size = liveEntrySize({
            row: planned ? { ...r, stop: planned.v3_stop } : r,
            balance: simQuote,
            budget: simBudget,
            slots: Math.max(1, liveSlots - livePlans.length),
            riskPct: liveRiskPct,
            minimum: minimumFor(r),
          });
          if (!(size >= 10)) continue;
          livePlans.push({ r, size: round(size, 2) });
          simBudget -= size;
          simQuote -= size * 1.005;
        }
      }
      // the live desk claims only setups it has an affordable plan for;
      // everything else stays in the paper pool
      const liveSymbols = new Set(livePlans.map((p) => p.r.symbol));
      const paperGated = tradable
        .filter((r) => !liveSymbols.has(r.symbol) && qualifies(r, "paper"))
        .map((r) => withV3(r, "paper"));
      const paperTop = paperView.always_take_top === true && !v3DeskOn.paper
        ? topPicksFor(tradable, "paper", topCount(paperView), liveSymbols)
        : [];
      const paperWanted = [...paperGated, ...paperTop]
        .filter((r, index, all) => all.findIndex((x) => x.symbol === r.symbol) === index)
        .map((r) => withDominance(r, paperView))
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
        .slice(0, Math.max(0, paperMaxOpen - paperOpenCount));
      if (dryRun) {
        const plans = [];
        for (const r of liveWanted) {
          if (stillOpen.some(t => t.symbol === r.symbol)) continue;
          const rl = atLive(r);
          const size = sizeLive(rl, Math.max(1, liveSlots - plans.length));
          if (!size) continue;
          plans.push({ symbol: r.symbol, side: r.side, score: r.score, size_usd: size,
            entry: rl.entry, stop: r.stop, target: liveUseEngine ? liveEngineTarget(rl) : r.target });
          quoteLeft -= size * 1.005;
          liveBudget -= size;
        }
        return Response.json({ dry_run: true, mode: config.mode, scanned: board.scannedCount,
          live: {         entry_ready: live.conn != null && liveVerified && !isBackedOff(connRow), reason: live.reason,
            spendable_quote: spendableQuote, budget_cap: liveBudgetCap, planned: plans },
          paper: { qualifying: paperWanted.filter(r => !stillOpen.some(t => t.symbol === r.symbol))
            .map(r => ({ symbol: r.symbol, side: r.side, score: r.score })) },
          rule_lock: collectGateLocks(tradable, gateReason, { desks: ["live", "paper"],
            slots: { live: liveMaxOpen - liveOpenCount, paper: paperMaxOpen - paperOpenCount },
            blocked: { live: blockedLive, paper: blockedPaper },
            taken: { live: plans.length, paper: paperWanted.length } }),
          v3: v3Summary });
      }
      const takenSymbols = new Set([...liveWanted, ...paperWanted].map((r) => r.symbol));
      scanLog = {
        scanned: board.scannedCount,
        blocked: 0,
        below_score: tradable.filter((r) => !takenSymbols.has(r.symbol)).length,
        taken: takenSymbols.size,
      };

      stage = "entries";
      for (const { r, desk } of [
        ...liveWanted.map((row) => ({ r: row, desk: "live" })),
        ...paperWanted.map((row) => ({ r: row, desk: "paper" })),
      ]) {
        // final guard: even if a paged read missed it, never open a second
        // position in a symbol that already has one open
        const alreadyOpen = await base44.entities.Trade.count({
          status: "open",
          symbol: r.symbol,
          created_by_id: config.created_by_id || user.id,
        });
        if (alreadyOpen) continue;
        // the measured exit, if this desk runs it: its 2xATR stop replaces the
        // scan's, and the trade is risked between entry and that stop — so the
        // size has to follow the wider stop, or a doubled stop would quietly
        // double the risk the desk was told to take (see measuredExitFields)
        const view = desk === "live" ? liveView : paperView;
        const measured = measuredExitFields(r, view, r.entry);
        const tradeStop = measured ? measured.v3_stop : r.stop;
        const stopDist = Math.abs(r.entry - tradeStop);
        if (!(stopDist > 0)) continue;

        // paper sizing — also what "match paper" live sizing spends
        const freeSlots = Math.max(
          1,
          paperMaxOpen - paperOpenCount - opened.filter((o) => o.mode === "paper").length - proposed.length,
        );
        const cap = cash / freeSlots;
        const riskUsd = (cash * riskPct) / 100;
        let qty = riskUsd / stopDist;
        let sizeUsd = qty * r.entry;
        if (sizeUsd > cap) {
          sizeUsd = cap;
          qty = sizeUsd / r.entry;
        }
        // concentration cap: no single position may exceed the desk's share of
        // equity, whatever the risk maths asked for
        const riskCapped = capPositionSize(sizeUsd, Number(config.starting_balance) || 10000);
        if (riskCapped < sizeUsd && riskCapped >= 10) {
          sizeUsd = riskCapped;
          qty = sizeUsd / r.entry;
        }

        // live leg: a market buy on the exchange, sized by the live risk
        // rules — risk per trade % of the spendable exchange balance, risked
        // between entry and stop (the same maths as the paper desk), within
        // the live budget. A refused order is alerted and a live-qualified
        // setup never falls back to paper silently.
        let real = null;
        let realSizeUsd = 0;
        // the live leg spends its pre-sized plan; a setup without an
        // affordable plan was never claimed, so paper inherits it below
        const plan = desk === "live" ? livePlans.find((p) => p.r.symbol === r.symbol) : null;
        const rl = plan ? plan.r : atLive(r);
        if (plan && live.conn && liveBudget >= 10 && spendableQuote >= 10) {
          realSizeUsd = plan.size;
          const isShort = r.side === "short";
          real = await placeMarketOrder(live.conn, {
            symbol: r.symbol,
            side: isShort ? "sell" : "buy",
            usd: realSizeUsd,
            price: rl.entry,
            // a live short is a Kraken margin order: the account sells an
            // asset it holds none of, backed by the margin account
            ...(isShort ? { margin: true, leverage: liveEngine.leverage } : {}),
          });
          if (!real.ok) {
            await base44.entities.Alert.create({
              symbol: r.symbol,
              title: `Real order failed on ${r.symbol}`,
              message: real.message,
              mode: "live",
              kind: "order_failed",
              severity: "danger",
            });
            continue;
          }
          liveBudget -= realSizeUsd;
          quoteLeft -= realSizeUsd * 1.005;
        }

        if (real) {
          const created = await base44.entities.Trade.create({
            symbol: r.symbol,
            name: r.name,
            image: r.image,
            side: r.side,
            mode: "real",
            status: config.mode === "auto" ? "open" : "proposed",
            entry_price: round(real.avg_price || rl.entry, 8),
            quantity: round(real.filled_qty || realSizeUsd / r.entry, 8),
            size_usd: round(realSizeUsd),
            stop_price: measured ? measured.v3_stop : r.stop,
            target_price: measured || r.v3 ? null : liveUseEngine ? liveEngineTarget(rl) : r.target,
            target_r: measured || r.v3 ? 0 : liveEngine.targetR,
            ...(r.v3
              ? {
                  v3_algo: true,
                  v3_stop: round(r.stop, 8),
                  v3_horizon_bars: r.v3.horizon_bars,
                  v3_atr: round(r.v3.atr, 8),
                }
              : measured || {}),
            peak_price: real.avg_price || rl.entry,
            // the risk it is opened with, fixed now so its R divides by what
            // it risked rather than by a stop that later trailed to break-even
            risk_pct: round(riskPctAt(real.avg_price || rl.entry, measured ? measured.v3_stop : r.stop), 2),
            score: r.score,
            pattern: `${r.side}/${r.market_cap_bucket}`,
            entry_source: r.v3 ? "v3" : r.top_pick ? "top_pick" : "gated",
            // the live desk's rules as they stood at the entry, copied onto
            // the trade: a closed row is then read against what opened it
            rules_snapshot: rulesSnapshot({ desk: "live", book: "USD", view: liveView, btcAbove200d }),
            // what the scan saw on this setup, copied with it
            entry_context: entryContext({
              row: r,
              btcChange24h: btcChange,
              medianChange24h: board.medianChange24h,
              dominance,
            }),
            exchange: live.conn.exchange,
            exchange_order_id: real.order_id,
            rationale: (r.reasons || []).join(" • "),
            opened_at: new Date().toISOString(),
          });
          if (config.mode === "auto") {
            opened.push({
              id: created.id,
              symbol: r.symbol,
              side: r.side,
              entry: r.entry,
              size_usd: round(realSizeUsd),
              mode: "real",
            });
            await base44.entities.Alert.create({
              symbol: r.symbol,
              title: `Bot opened a ${r.side} on ${r.symbol}`,
              message: r.v3
                ? `Entry ${r.entry}, V3 stop ${r.stop} (2xATR daily). No target: held up to ${r.v3.horizon_bars} daily bars. Real order placed on ${live.conn.label}.`
                : `Entry ${r.entry}, target ${r.target} (${r.required_move_pct}% move), stop ${r.stop}. Score ${r.score}. Real order placed on ${live.conn.label}.`,
              mode: "live",
              kind: "bot_open",
              severity: "info",
              trade_id: created.id,
            });
          } else {
            proposed.push({
              id: created.id,
              symbol: r.symbol,
              side: r.side,
              entry: r.entry,
              target: r.target,
              stop: r.stop,
              score: r.score,
              size_usd: round(realSizeUsd),
            });
          }
          continue;
        }

        // paper leg: booked against the paper cash balance only
        if (desk !== "paper" || sizeUsd < 10) continue;
        const created = await base44.entities.Trade.create({
          symbol: r.symbol,
          name: r.name,
          image: r.image,
          side: r.side,
          mode: "paper",
          status: config.mode === "auto" ? "open" : "proposed",
          entry_price: round(r.entry, 8),
          quantity: round(qty, 8),
          size_usd: round(sizeUsd),
          stop_price: measured ? measured.v3_stop : r.stop,
          target_price: measured || r.v3 ? null : paperUseEngine ? paperEngineTarget(r) : r.target,
          target_r: measured || r.v3 ? 0 : paperEngine.targetR,
          ...(r.v3
            ? {
                v3_algo: true,
                v3_stop: round(r.stop, 8),
                v3_horizon_bars: r.v3.horizon_bars,
                v3_atr: round(r.v3.atr, 8),
              }
            : measured || {}),
          peak_price: r.entry,
          // the risk it is opened with, fixed at the entry (see above)
          risk_pct: round(riskPctAt(r.entry, measured ? measured.v3_stop : r.stop), 2),
          score: r.score,
          pattern: `${r.side}/${r.market_cap_bucket}`,
          entry_source: r.v3 ? "v3" : r.top_pick ? "top_pick" : "gated",
          // the paper desk's rules as they stood at the entry
          rules_snapshot: rulesSnapshot({ desk: "paper", book: "USD", view: paperView, btcAbove200d }),
          entry_context: entryContext({
            row: r,
            btcChange24h: btcChange,
            medianChange24h: board.medianChange24h,
            dominance,
          }),
          rationale: (r.reasons || []).join(" • "),
          opened_at: new Date().toISOString(),
        });
        if (config.mode === "auto") {
          cash -= sizeUsd;
          opened.push({
            id: created.id,
            symbol: r.symbol,
            side: r.side,
            entry: r.entry,
            size_usd: round(sizeUsd),
            mode: "paper",
          });
          await base44.entities.Alert.create({
            symbol: r.symbol,
            title: `Bot opened a ${r.side} on ${r.symbol}`,
            message: r.v3
              ? `Entry ${r.entry}, V3 stop ${r.stop} (2xATR daily). No target: held up to ${r.v3.horizon_bars} daily bars.`
              : `Entry ${r.entry}, target ${r.target} (${r.required_move_pct}% move), stop ${r.stop}. Score ${r.score}.`,
            mode: "paper",
            kind: "bot_open",
            severity: "info",
            trade_id: created.id,
          });
        } else {
          proposed.push({
            id: created.id,
            symbol: r.symbol,
            side: r.side,
            entry: r.entry,
            target: r.target,
            stop: r.stop,
            score: r.score,
            size_usd: round(sizeUsd),
          });
        }
      }

      // ---- the Bitcoin book (paper). The desk's own rules, read on the BTC
      // market's own board: the same score gates or V3 plan, the same top-pick
      // option, the same risk sizing, cooldowns and slots. A BTC-quoted row is
      // priced in bitcoin, so its entry, stop, target and quantity are all BTC
      // while size_usd and pnl_usd are that move at the rate it opened at.
      // A failure here costs BTC entries, never the cycle.
      try {
        const paperBtcOn =
          btcMarketsOn(paperView) && btcUsdNow > 0 && paperBtcOpen < paperBtcMaxOpen && !dryRun;
        // only the Bitcoin book's own positions and its own openings keep a coin
        // out: the same coin may be held in dollars and in bitcoin, because they
        // are two markets on two bankrolls
        const already = new Set([
          ...stillOpen.filter((t) => quoteOf(t.quote_asset) === "BTC").map((t) => t.symbol),
          ...opened.filter((o) => o.quote === "BTC").map((o) => o.symbol),
        ]);
        // the Bitcoin market's own board decides, exactly as the dollar board
        // decides the dollar book: the desk's gates, its top-pick option, its
        // V3 plan. `already` keeps one coin out of a second entry in another
        // currency.
        const btcGatedPaper = btcTradable
          .filter((r) => !already.has(r.symbol) && btcQualifies(r, "paper"))
          .map((r) => btcWithV3(r, "paper"));
        const btcTopPaper = paperBtcView.always_take_top === true && !btcV3DeskOn.paper
          ? topPicksFor(btcTradable, "paper", topCount(paperBtcView), undefined, true)
          : [];
        const btcCandidates = [...btcGatedPaper, ...btcTopPaper]
          .filter((r, index, all) => all.findIndex((x) => x.symbol === r.symbol) === index)
          .filter((r) => !already.has(r.symbol))
          .map((r) => withDominance(r, paperBtcView))
          .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
          .slice(0, 5);
        for (const btcRow of paperBtcOn ? btcCandidates : []) {
          const btcTaken = opened.filter((o) => o.mode === "paper" && o.quote === "BTC").length;
          if (btcTaken >= Math.max(0, paperBtcMaxOpen - paperBtcOpen)) break;
          if (!(Number(btcRow.entry) > 0)) continue;
          // the measured exit, if this desk runs it (see measuredExitFields):
          // its stop is in this market's own quote, which is bitcoin here, and
          // the size must follow it exactly as the dollar book's does
          const btcMeasured = measuredExitFields(btcRow, paperBtcView, btcRow.entry);
          const btcTradeStop = btcMeasured ? btcMeasured.v3_stop : btcRow.stop;
          const stopUsd = Math.abs(btcRow.entry - btcTradeStop) * btcUsdNow;
          if (!(stopUsd > 0)) continue;
          const freeBtcSlots = Math.max(1, paperBtcMaxOpen - paperBtcOpen - btcTaken);
          const btcRiskUsd = (btcCash * btcRiskPct) / 100;
          let btcQty = btcRiskUsd / stopUsd;
          let btcSizeUsd = btcQty * btcRow.entry * btcUsdNow;
          const btcCap = btcCash / freeBtcSlots;
          if (btcSizeUsd > btcCap) {
            btcSizeUsd = btcCap;
            btcQty = btcSizeUsd / (btcRow.entry * btcUsdNow);
          }
          const btcCapped = capPositionSize(btcSizeUsd, btcStart);
          if (btcCapped < btcSizeUsd && btcCapped >= 10) {
            btcSizeUsd = btcCapped;
            btcQty = btcSizeUsd / (btcRow.entry * btcUsdNow);
          }
          if (!(btcSizeUsd >= 10) || !(btcQty > 0)) continue;
          const btcTarget = btcRow.v3 ? null : paperBtcUseEngine ? paperBtcEngineTarget(btcRow) : btcRow.target;
          const btcCreated = await base44.entities.Trade.create({
            symbol: btcRow.symbol,
            name: btcRow.name,
            image: btcRow.image,
            side: btcRow.side,
            mode: "paper",
            status: config.mode === "auto" ? "open" : "proposed",
            entry_price: round(btcRow.entry, 8),
            quantity: round(btcQty, 8),
            size_usd: round(btcSizeUsd),
            stop_price: btcMeasured ? btcMeasured.v3_stop : round(btcRow.stop, 8),
            target_price: btcMeasured || btcTarget == null ? null : round(btcTarget, 8),
            target_r: btcMeasured || btcRow.v3 ? 0 : paperBtcEngine.targetR,
            ...(btcRow.v3
              ? {
                  v3_algo: true,
                  v3_stop: round(btcRow.stop, 8),
                  v3_horizon_bars: btcRow.v3.horizon_bars,
                  v3_atr: round(btcRow.v3.atr, 8),
                }
              : btcMeasured || {}),
            peak_price: round(btcRow.entry, 8),
            // the risk in the pair's own quote: a percent reads the same
            risk_pct: round(riskPctAt(btcRow.entry, btcMeasured ? btcMeasured.v3_stop : btcRow.stop), 2),
            score: btcRow.score,
            pattern: patternFor(btcRow.side, btcRow.market_cap_bucket, "BTC"),
            entry_source: btcRow.v3 ? "v3" : btcRow.top_pick ? "top_pick" : "gated",
            // the paper Bitcoin book's own rules, never the dollar desk's
            rules_snapshot: rulesSnapshot({ desk: "paper", book: "BTC", view: paperBtcView, btcAbove200d }),
            entry_context: entryContext({
              row: btcRow,
              btcChange24h: btcChange,
              medianChange24h: board.medianChange24h,
              dominance,
            }),
            quote_asset: "BTC",
            fx_usd: round(btcUsdNow, 2),
            rationale: [
              ...(btcRow.reasons || []),
              `BTC-quoted market ${btcRow.symbol}/XBT on Kraken — ${round(btcSizeUsd, 2)} USD at BTC ${round(btcUsdNow, 2)}`,
            ].join(" • "),
            opened_at: new Date().toISOString(),
          });
          if (config.mode === "auto") {
            btcCash -= btcSizeUsd;
            opened.push({
              id: btcCreated.id,
              symbol: btcRow.symbol,
              side: btcRow.side,
              entry: btcRow.entry,
              size_usd: round(btcSizeUsd),
              mode: "paper",
              quote: "BTC",
            });
            await base44.entities.Alert.create({
              symbol: btcRow.symbol,
              title: `Bot opened a ${btcRow.side} on ${btcRow.symbol}/XBT`,
              message: `BTC-quoted market: entry ${round(btcRow.entry, 8)} BTC, stop ${round(btcRow.stop, 8)} BTC, target ${round(btcTarget, 8)} BTC. ${round(btcSizeUsd, 2)} USD at BTC ${round(btcUsdNow, 2)}. Score ${btcRow.score}.`,
              mode: "paper",
              kind: "bot_open",
              severity: "info",
              trade_id: btcCreated.id,
            });
          } else {
            proposed.push({
              id: btcCreated.id,
              symbol: btcRow.symbol,
              side: btcRow.side,
              entry: btcRow.entry,
              target: btcTarget,
              stop: btcRow.stop,
              score: btcRow.score,
              size_usd: round(btcSizeUsd),
            });
          }
        }
      } catch (err) {
        console.log(`BTC-quoted leg failed: ${String((err && err.message) || err)}`);
      }

      // ---- BTC-quoted leg (live). The same switch on the live desk, and this
      // one places a real order on Kraken's Bitcoin market: sized from the
      // account's own Bitcoin balance, risked between the pair's entry and
      // stop exactly as a dollar order is, and recorded in BTC with the rate
      // it opened at, so its dollar figures still read. It never spends the
      // dollar quote's cash, and it takes only symbols the desk did not take
      // this cycle, so one coin is never bought twice in two currencies.
      // Longs only: a Bitcoin short is a margin position on a market this
      // book has not been measured on. A failure here costs BTC entries,
      // never the cycle.
      try {
        // what this book may deploy: its share of the account's Bitcoin, held
        // under its hard cap. The rest stays on the exchange untouched, so a 50%
        // setting or a small cap never spends the whole holding
        const btcSpendableNow = btcSpendLimit(pickBtcBalance(btcBalances), btcUsePct, btcCapBtc);
        // the first gate this pass would fail, in the order they are checked:
        // the desk reads this back so an idle Bitcoin book says why, whether the
        // reason is the switch, the venue, the key, the holding or the limits
        btcBlocked = !btcMarketsOn(liveView)
          ? "BTC markets are off for the live book — switch them on under Bot → Rules → Live rules."
          : !btcVenue
            ? "No connected exchange lists Bitcoin markets — connect one under Settings."
            : !liveBtcVenue
              ? `The live account is on ${live.conn ? live.conn.exchange : "another exchange"}, not ${btcVenue.label}, so a Bitcoin order would have no market to fill on.`
              : !liveVerified
                ? "The exchange key is not verified for trading — reconnect it under Settings."
                : isBackedOff(connRow)
                  ? "The exchange locked this key after failed reads — no order can fire until the lock clears or the key is reconnected."
                  : !(btcUsdNow > 0)
                    ? "The Bitcoin rate is missing this cycle, so nothing can be sized."
                    : !(btcSpendableNow > 0)
                      ? "No Bitcoin on the exchange to spend — the book spends only the spot Bitcoin it holds."
                      : !(btcSpendableNow * btcUsdNow >= 10)
                        ? `The usable Bitcoin (${round(btcSpendableNow, 8)} BTC ≈ ${round(btcSpendableNow * btcUsdNow)} USD) is under the 10 USD minimum entry — raise the share or the hard cap.`
                        : null;
        // the live connection must be the venue that lists these pairs, so a
        // Bitcoin entry is never sent to an account without the market: the book
        // then keeps scanning for its paper side only
        if (
          liveBtcVenue && btcMarketsOn(liveView) && liveReady && btcUsdNow > 0 &&
          btcSpendableNow > 0 && !dryRun
        ) {
          // the live Bitcoin book's own positions and its own openings: never
          // the dollar book's, which is a different market and a different money
          const takenBtc = new Set([
            ...stillOpen
              .filter((t) => (t.mode || "paper") === "real" && quoteOf(t.quote_asset) === "BTC")
              .map((t) => t.symbol),
            ...opened.filter((o) => o.quote === "BTC").map((o) => o.symbol),
          ]);
          // the same selection the dollar book gets — the desk's gates, its
          // top-pick option, its V3 plan — read on the Bitcoin board. Longs
          // only: a Bitcoin short is a margin position on a market this book
          // has not been measured on.
          const btcGatedLive = btcTradableLive
            .filter((r) => !takenBtc.has(r.symbol) && btcQualifies(r, "live"))
            .map((r) => btcWithV3(r, "live"))
            .filter((r) => r.side === "long");
          const btcTopLive = liveBtcView.always_take_top === true && !btcV3DeskOn.live
            ? topPicksFor(btcTradableLive, "live", topCount(liveBtcView), undefined, true).filter((r) => r.side === "long")
            : [];
          const btcSeeds = [...btcGatedLive, ...btcTopLive]
            .filter((r, index, all) => all.findIndex((x) => x.symbol === r.symbol) === index)
            .filter((r) => !takenBtc.has(r.symbol))
            .map((r) => withDominance(r, liveBtcView))
            .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
            .slice(0, 5);
          // this book's slots are its own: the dollar plans were sized against
          // the dollar book, and neither can take the other's room
          const btcSlots = liveBtcMaxOpen - liveBtcOpen;
          let btcLeft = btcSpendableNow;
          // the budget is the Bitcoin the account actually holds — this book
          // has no dollar cap, and the dollar cap never limits it
          let btcBudgetUsd = btcSpendableNow * btcUsdNow;
          for (const seed of btcSeeds) {
            if (!(btcSlots > 0)) break;
            // only this book's own openings count against its slots: a dollar
            // entry made earlier this cycle never blocks a Bitcoin one
            if (opened.filter((o) => o.mode === "real" && o.quote === "BTC").length >= btcSlots) break;
            if (!(btcLeft > 0) || btcBudgetUsd < 10) break;
            const btcLiveRow = seed;
            if (!(Number(btcLiveRow.entry) > 0)) continue;
            // one position per coin: an open row in the same symbol means
            // the seed filter above already skipped it, and this catches a
            // row past the first page of that read
            const btcOpen = await base44.entities.Trade.count({
              status: "open",
              symbol: btcLiveRow.symbol,
              quote_asset: "BTC",
              created_by_id: config.created_by_id || user.id,
            });
            if (btcOpen) continue;
            // the dollar floor in bitcoin — $10 of this market — or the
            // exchange's own minimum, whichever is larger
            const floorBtc = round(10 / btcUsdNow, 8);
            if (!(floorBtc > 0)) continue;
            // the measured exit, if this desk runs it (see measuredExitFields):
            // its wider stop is what the order is risked against
            const btcLiveMeasured = measuredExitFields(btcLiveRow, liveBtcView, btcLiveRow.entry);
            const minBtc = entryMinimum(constraints, btcLiveRow.symbol, "BTC", btcLiveRow.entry, floorBtc);
            const sizeBtc = liveEntrySize({
              row: btcLiveMeasured ? { ...btcLiveRow, stop: btcLiveMeasured.v3_stop } : btcLiveRow,
              balance: btcLeft,
              budget: round(btcBudgetUsd / btcUsdNow, 8),
              slots: btcSlots,
              riskPct: btcLiveRiskPct,
              minimum: minBtc,
              floor: floorBtc,
              decimals: 8,
            });
            if (!(sizeBtc > 0)) continue;
            const sizeBtcUsd = round(sizeBtc * btcUsdNow, 2);
            if (!(sizeBtcUsd >= 10)) continue;
            const baseQty = round(sizeBtc / btcLiveRow.entry, 8);
            if (!(baseQty > 0)) continue;
            const btcTargetLive = btcLiveRow.v3 ? null : liveBtcUseEngine ? liveBtcEngineTarget(btcLiveRow) : btcLiveRow.target;
            const btcRationale = [
              ...(btcLiveRow.reasons || []),
              `BTC-quoted market ${btcLiveRow.symbol}/XBT on ${live.conn.label} — ${round(sizeBtcUsd, 2)} USD at BTC ${round(btcUsdNow, 2)}`,
            ].join(" • ");
            // approve mode: the setup waits as a proposal and no order goes
            // out. Taking it places the real buy — that path knows the pair —
            // so nothing is bought twice by confirming what was already filled.
            if (config.mode !== "auto") {
              const btcProposal = await base44.entities.Trade.create({
                symbol: btcLiveRow.symbol,
                name: btcLiveRow.name,
                image: btcLiveRow.image,
                side: "long",
                mode: "real",
                status: "proposed",
                entry_price: round(btcLiveRow.entry, 8),
                quantity: baseQty,
                size_usd: sizeBtcUsd,
                stop_price: btcLiveMeasured ? btcLiveMeasured.v3_stop : round(btcLiveRow.stop, 8),
                target_price: btcLiveMeasured || btcTargetLive == null ? null : round(btcTargetLive, 8),
                target_r: btcLiveMeasured || btcLiveRow.v3 ? 0 : liveEngine.targetR,
                ...(btcLiveRow.v3
                  ? {
                      v3_algo: true,
                      v3_stop: round(btcLiveRow.stop, 8),
                      v3_horizon_bars: btcLiveRow.v3.horizon_bars,
                      v3_atr: round(btcLiveRow.v3.atr, 8),
                    }
                  : btcLiveMeasured || {}),
                peak_price: round(btcLiveRow.entry, 8),
                // the risk it is opened with, fixed at the entry (see above)
                risk_pct: round(riskPctAt(btcLiveRow.entry, btcLiveMeasured ? btcLiveMeasured.v3_stop : btcLiveRow.stop), 2),
                score: btcLiveRow.score,
                pattern: patternFor(btcLiveRow.side, btcLiveRow.market_cap_bucket, "BTC"),
                entry_source: btcLiveRow.v3 ? "v3" : btcLiveRow.top_pick ? "top_pick" : "gated",
                // the live Bitcoin book's own rules, copied at the proposal
                rules_snapshot: rulesSnapshot({ desk: "live", book: "BTC", view: liveBtcView, btcAbove200d }),
                entry_context: entryContext({
                  row: btcLiveRow,
                  btcChange24h: btcChange,
                  medianChange24h: board.medianChange24h,
                  dominance,
                }),
                quote_asset: "BTC",
                fx_usd: round(btcUsdNow, 2),
                rationale: btcRationale,
                opened_at: new Date().toISOString(),
              });
              proposed.push({
                id: btcProposal.id,
                symbol: btcLiveRow.symbol,
                side: "long",
                entry: btcLiveRow.entry,
                target: btcTargetLive,
                stop: btcLiveRow.stop,
                score: btcLiveRow.score,
                size_usd: sizeBtcUsd,
              });
              continue;
            }
            // the price and the pair travel with the order: Kraken names a
            // Bitcoin market SOLXBT, and sizing a buy needs the pair's price
            const order = await placeMarketOrder(live.conn, {
              symbol: btcLiveRow.symbol,
              side: "buy",
              usd: sizeBtcUsd,
              quantity: baseQty,
              price: btcLiveRow.entry,
              quote: "BTC",
            });
            if (!order.ok) {
              await base44.entities.Alert.create({
                symbol: btcLiveRow.symbol,
                title: `Real BTC-market order failed on ${btcLiveRow.symbol}`,
                message: order.message,
                mode: "live",
                kind: "order_failed",
                severity: "danger",
              });
              break;
            }
            // what it just spent is no longer free for the next coin. The
            // dollar budget is untouched: this book never spends dollars.
            btcLeft -= sizeBtc * 1.005;
            btcBudgetUsd -= sizeBtcUsd;
            const filledQty = round(Number(order.filled_qty) || baseQty, 8);
            const fillPx = round(Number(order.avg_price) || btcLiveRow.entry, 8);
            const btcCreatedLive = await base44.entities.Trade.create({
              symbol: btcLiveRow.symbol,
              name: btcLiveRow.name,
              image: btcLiveRow.image,
              side: "long",
              mode: "real",
              status: "open",
              entry_price: fillPx,
              quantity: filledQty,
              size_usd: sizeBtcUsd,
              stop_price: btcLiveMeasured ? btcLiveMeasured.v3_stop : round(btcLiveRow.stop, 8),
              target_price: btcLiveMeasured || btcTargetLive == null ? null : round(btcTargetLive, 8),
              target_r: btcLiveMeasured || btcLiveRow.v3 ? 0 : liveEngine.targetR,
              ...(btcLiveRow.v3
                ? {
                    v3_algo: true,
                    v3_stop: round(btcLiveRow.stop, 8),
                    v3_horizon_bars: btcLiveRow.v3.horizon_bars,
                    v3_atr: round(btcLiveRow.v3.atr, 8),
                  }
                : btcLiveMeasured || {}),
              peak_price: fillPx,
              // measured from the fill it actually got, to the stop it carries
              risk_pct: round(riskPctAt(fillPx, btcLiveMeasured ? btcLiveMeasured.v3_stop : btcLiveRow.stop), 2),
              score: btcLiveRow.score,
              pattern: patternFor(btcLiveRow.side, btcLiveRow.market_cap_bucket, "BTC"),
              entry_source: btcLiveRow.v3 ? "v3" : btcLiveRow.top_pick ? "top_pick" : "gated",
              // the live Bitcoin book's own rules, copied at the fill
              rules_snapshot: rulesSnapshot({ desk: "live", book: "BTC", view: liveBtcView, btcAbove200d }),
              entry_context: entryContext({
                row: btcLiveRow,
                btcChange24h: btcChange,
                medianChange24h: board.medianChange24h,
                dominance,
              }),
              quote_asset: "BTC",
              fx_usd: round(btcUsdNow, 2),
              exchange: live.conn.exchange,
              exchange_order_id: order.order_id,
              rationale: btcRationale,
              opened_at: new Date().toISOString(),
            });
            opened.push({
              id: btcCreatedLive.id,
              symbol: btcLiveRow.symbol,
              side: "long",
              entry: btcLiveRow.entry,
              size_usd: sizeBtcUsd,
              mode: "real",
              quote: "BTC",
            });
            await base44.entities.Alert.create({
              symbol: btcLiveRow.symbol,
              title: `Bot opened a long on ${btcLiveRow.symbol}/XBT`,
              message: `BTC-quoted market, real order on ${live.conn.label}: entry ${round(btcLiveRow.entry, 8)} BTC, stop ${round(btcLiveRow.stop, 8)} BTC, target ${round(btcTargetLive, 8)} BTC. ${round(sizeBtcUsd, 2)} USD at BTC ${round(btcUsdNow, 2)}. Score ${btcLiveRow.score}.`,
              mode: "live",
              kind: "bot_open",
              severity: "info",
              trade_id: btcCreatedLive.id,
            });
          }
        }
      } catch (err) {
        console.log(`BTC-quoted live leg failed: ${String((err && err.message) || err)}`);
      }

      Object.assign(
        deskDiag,
        collectGateLocks(tradable, gateReason, {
          desks: live.conn ? ["live", "paper"] : ["paper"],
          slots: { live: liveMaxOpen - liveOpenCount, paper: paperMaxOpen - paperOpenCount },
          blocked: { live: blockedLive, paper: blockedPaper },
          taken: { live: liveSymbols.size, paper: paperWanted.length },
        }),
      );
    }

    if (dryRun) return Response.json({ dry_run: true, mode: config.mode, scanned: 0,
      live: {         entry_ready: live.conn != null && liveVerified && !isBackedOff(connRow), reason: live.reason, planned: [] },
      paper: { qualifying: [] }, reason: config.mode === "off" ? "Signals only" : "No open position slots" });

    // rule-lock alerts: one warning per desk per 6 hours when the desk's own
    // rules rejected every candidate the scan produced
    if (!light) await raiseGateLockAlerts(base44, deskDiag, config.created_by_id);

    // ---- daily goal check. "Today" follows the user's clock, not UTC: the
    // old UTC-midnight boundary bucketed an evening trader's results into
    // the next day, so the counter disagreed with the journal (even flipping
    // sign). The desk sends getTimezoneOffset() (minutes west of UTC);
    // callers that don't send it keep the UTC day.
    const tzOffset = Number.isFinite(body.tz_offset) ? Number(body.tz_offset) : 0;
    const localNowMs = Date.now() - tzOffset * 60000;
    const dayStartMs = Math.floor(localNowMs / 86400000) * 86400000 + tzOffset * 60000;
    const dayStart = new Date(dayStartMs);
    const todayKey = new Date().toISOString().slice(0, 10);
    // everything the desk stats need — the day's closes, the running totals,
    // and the four equity-candle reads — in one parallel round instead of
    // eight serial waits; this chain was seconds of every cycle
    stage = "stats";
    const [todays, realizedAgg, deployedAgg, btcRealizedAgg, btcDeployedAgg, prevCandlesPage, existingCandlePage, prevLivePage, existingLivePage] =
      await Promise.all([
        readAll({ status: "closed", closed_at: { $gte: dayStart.toISOString() }, created_by_id: user.id }),
        base44.entities.Trade.aggregate({ query: { status: "closed", mode: "paper", created_by_id: user.id }, sum: "pnl_usd" }),
        base44.entities.Trade.aggregate({ query: { status: "open", mode: "paper", created_by_id: user.id }, sum: "size_usd" }),
        // the Bitcoin book is matched positively, so a desk that never traded it
        // reads exactly as it did before the book existed
        base44.entities.Trade.aggregate({ query: { status: "closed", mode: "paper", quote_asset: "BTC", created_by_id: user.id }, sum: "pnl_usd" }),
        base44.entities.Trade.aggregate({ query: { status: "open", mode: "paper", quote_asset: "BTC", created_by_id: user.id }, sum: "size_usd" }),
        base44.entities.EquityCandle.filter({ owner: user.id, day: { $lt: todayKey } }, { sort: "-day", limit: 1 }),
        base44.entities.EquityCandle.filter({ owner: user.id, day: todayKey }, { limit: 1 }),
        base44.entities.EquityCandle.filter({ owner: `${user.id}|live`, day: { $lt: todayKey } }, { sort: "-day", limit: 1 }),
        base44.entities.EquityCandle.filter({ owner: `${user.id}|live`, day: todayKey }, { limit: 1 }),
      ]);
    const prevCandles = asArray(prevCandlesPage);
    const existingCandle = asArray(existingCandlePage)[0];
    const prevLiveCandles = asArray(prevLivePage);
    const existingLive = asArray(existingLivePage)[0];
    // the headline counter and the daily goal track the paper bot's results —
    // real trades already report through the live stats block
    // the headline counter, the daily goal and the equity candle are the dollar
    // book's. The Bitcoin book reports its own day and never moves these.
    const paperTodays = todays.filter((t) => (t.mode || "paper") === "paper" && quoteOf(t.quote_asset) === "USD");
    const btcTodays = todays.filter((t) => (t.mode || "paper") === "paper" && quoteOf(t.quote_asset) === "BTC");
    const realizedToday = paperTodays.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);
    const btcRealizedToday = btcTodays.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);
    const startBalance = Number(config.starting_balance) || 10000;
    const goal = (startBalance * (Number(config.daily_target_pct) || 2)) / 100;
    let goalHit = false;
    if (goal > 0 && realizedToday >= goal) {
      goalHit = true;
      const existing = asArray(
        await base44.entities.Alert.filter(
          { kind: "daily_goal", created_date: { $gte: dayStart.toISOString() } },
          { limit: 5 },
        ),
      );
      if (!existing.length) {
        await base44.entities.Alert.create({
          title: `Daily target reached: +${round((realizedToday / startBalance) * 100)}%`,
          message: `Closed profit today is ${round(realizedToday)} USD against a ${round(goal)} USD target.`,
          mode: "paper",
          kind: "daily_goal",
          severity: "success",
        });
      }
    }

    // ---- live (exchange) stats: every real trade, bot-placed or hand-logged
    const livePositions = openTrades
      .filter((t) => (t.mode || "paper") === "real")
      .map((t) => {
      const side = t.side === "short" ? "short" : "long";
      const entry = Number(t.entry_price) || 0;
      // a BTC-quoted position's own levels are in bitcoin: its price is the
      // pair's price in BTC, taken from the dollar quote at the rate — or the
      // entry would be compared with a dollar price and the position would
      // report a P&L of a hundred times its size. The rate is the live one,
      // else the rate recorded when the trade opened.
      const posQuote = quoteOf(t.quote_asset);
      const posFx = posQuote === "BTC" ? btcUsdNow || Number(t.fx_usd) || 0 : 1;
      const priceUsd = Number(priceMap.get(t.symbol)?.price) || 0;
      // without a rate the position is still listed, marked at its own entry —
      // a position must never vanish off the desk because a price is missing
      const price = posQuote === "BTC" ? (priceUsd > 0 && posFx > 0 ? priceUsd / posFx : entry) : priceUsd || entry;
      const qty = Number(t.quantity) || 0;
      const size = Number(t.size_usd) || 0;
      const unreal = entry && price
        ? toUsd(side === "long" ? (price - entry) * qty : (entry - price) * qty, posQuote, posFx)
        : 0;
      const goal = Number(t.target_price) ? Math.abs(Number(t.target_price) - entry) : 0;
      const travelled = side === "long" ? price - entry : entry - price;
      return {
        id: t.id,
        symbol: t.symbol,
        name: t.name,
        image: t.image,
        side,
        mode: "real",
        quote_asset: posQuote,
        exchange: t.exchange || null,
        // the pair this position actually lives on: a Bitcoin-market position
        // is a XBT pair, never the dollar one of the same coin
        pair: `${t.symbol}/${
          posQuote === "BTC"
            ? "XBT"
            : (funding && funding.asset) || QUOTE_ASSET[t.exchange] || "USDT"
        }`,
        entry_price: entry,
        current_price: round(price, 8),
        stop_price: t.stop_price,
        target_price: t.target_price,
        size_usd: round(size),
        pnl_usd: round(unreal),
        pnl_pct: size ? round((unreal / size) * 100) : 0,
        progress_pct: goal ? round(Math.max(0, Math.min(100, (travelled / goal) * 100))) : 0,
      };
    });
    // the live cap is the dollar book's, so only dollar positions count against
    // it. The Bitcoin book's limit is the Bitcoin the account holds.
    const liveExposure = livePositions
      .filter((p) => quoteOf(p.quote_asset) === "USD")
      .reduce((a, p) => a + p.size_usd, 0);
    const liveBtcExposure = livePositions
      .filter((p) => quoteOf(p.quote_asset) === "BTC")
      .reduce((a, p) => a + p.size_usd, 0);
    // the Bitcoin book's own live figures: its positions' P&L and its day, so
    // a desk showing that book shows nothing of the dollar one
    const liveBtcUnrealized = livePositions
      .filter((p) => quoteOf(p.quote_asset) === "BTC")
      .reduce((a, p) => a + (Number(p.pnl_usd) || 0), 0);
    const liveBtcTodays = todays.filter(
      (t) => (t.mode || "paper") === "real" && quoteOf(t.quote_asset) === "BTC",
    );
    const liveBtcRealizedToday = liveBtcTodays.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);
    const liveUnrealized = livePositions.reduce((a, p) => a + p.pnl_usd, 0);
    // already fetched with the paper day's closes above: same status and same
    // time window, only the mode differs — no second read needed
    const liveRealized = todays
      .filter((t) => (t.mode || "paper") === "real")
      .reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);

    // the exchange's own quote-currency balance, refreshed on full cycles only
    let exchangeBalance = null;
    let freshBalances = null;
    let balanceAsOf = null;
    let balanceStale = false;
    let balanceError = null;
    stage = "exchange balance";
    if (managed.conn && !light && isBackedOff(managed.conn)) {
      // the key failed a signed read recently — do not touch it: every failed
      // attempt keeps the exchange-side lockout alive. The saved balance and
      // the stale flag carry the desk through until the backoff expires.
      balanceStale = true;
      balanceError = `Retrying ${managed.conn.label} after the last failed read — paused until ${managed.conn.backoff_until}`;
      if (managed.conn.balance_usd != null) {
        exchangeBalance = round(Number(managed.conn.balance_usd) || 0, 2);
        balanceAsOf = managed.conn.balance_updated_at || null;
      }
    } else if (managed.conn && !light && !balanceJustRead(managed.conn)) {
      const acct = await readAccount({
        exchange: managed.conn.exchange,
        testnet: managed.conn.testnet,
        api_key: managed.conn.api_key,
        api_secret: managed.conn.api_secret,
        passphrase: managed.conn.passphrase || "",
      });
      if (acct.ok) {
        freshBalances = acct.balances;
        // total account value (every holding priced) — the funding cash the
        // bot sizes with is read separately from the balances list
        exchangeBalance = await accountValueUsd(managed.conn, acct.balances);
        // keep the balance on the connection so a later failed read never
        // leaves the desk blank
        await base44.asServiceRole.entities.ExchangeConnection.update(managed.conn.id, {
          balance_usd: exchangeBalance,
          balance_updated_at: new Date().toISOString(),
          // the Bitcoin row always survives the cap (see keepBalances): a
          // holding of a few thousand satoshis has the smallest unit count on
          // the account and a plain cut would delete the one row the Bitcoin
          // book spends
          balances: keepBalances(acct.balances),
        });
        balanceAsOf = new Date().toISOString();
      } else {
        // never treat a failed read as current: the desk shows the failure
        balanceStale = true;
        balanceError = acct.message;
        // and every background reader backs the key off, so a failed read is
        // never retried straight into an exchange-side lockout
        await base44.asServiceRole.entities.ExchangeConnection.update(managed.conn.id, {
          backoff_until: backoffUntil(acct.message),
        });
        // but the last saved balance still beats a blank figure
        if (managed.conn.balance_usd != null) {
          exchangeBalance = round(Number(managed.conn.balance_usd) || 0, 2);
          balanceAsOf = managed.conn.balance_updated_at || null;
        }
      }
    }

    // ---- wallet sync: reconcile the desk's open real positions with what
    // the exchange actually holds. Untracked holdings are imported as
    // positions the bot then manages, positions sold off on the exchange are
    // closed on the desk, partial differences are reconciled. This runs on
    // every full cycle (throttled to one sync per 10 minutes) so the desk and
    // the wallet stay reconciled permanently.
    let walletSync = null;
    stage = "wallet sync";
    if (
      managed.conn &&
      !light &&
      !dryRun &&
      !isBackedOff(connRow) &&
      Date.now() - (Number(config.last_wallet_sync_at) || 0) > 10 * 60000
    ) {
      const syncBalances = freshBalances || (connRow && Array.isArray(connRow.balances) ? connRow.balances : null);
      if (syncBalances && syncBalances.length) {
        walletSync = await syncExchangePositions(
          base44,
          // the fill-history throttle reads the last pull time off the stored row
          { ...managed.conn, fills_fetched_at: connRow ? connRow.fills_fetched_at : null },
          syncBalances,
          {
          ownerId: config.created_by_id,
          stopPct: Number(lrVal("default_stop_pct", 2.5)),
          targetR: liveEngine.targetR || 0,
        });
        await base44.entities.BotConfig.update(config.id, { last_wallet_sync_at: Date.now() });
      }
    }

    // ---- live desk extras: the day's goal (the live target pct of the
    // exchange balance, saved balance when the live read failed) plus the
    // best and worst closed real trades of the day, so the desk can render
    // its progress and day movers without a second read
    const liveDayPct = Number(lrVal("daily_target_pct", 2)) || 2;
    const liveGoalBase =
      exchangeBalance != null
        ? exchangeBalance
        : managed.info?.balance_usd != null
          ? Number(managed.info.balance_usd)
          : null;
    const liveGoal = liveGoalBase != null ? round((liveGoalBase * liveDayPct) / 100) : null;
    const liveDayTrades = todays
      .filter((t) => (t.mode || "paper") === "real")
      .map((t) => ({
        symbol: t.symbol,
        side: t.side === "short" ? "short" : "long",
        pnl_usd: round(Number(t.pnl_usd) || 0),
        pnl_pct: round(Number(t.pnl_pct) || 0),
        exit_reason: t.exit_reason || null,
        exchange: t.exchange || null,
        closed_at: t.closed_at || null,
      }))
      .sort((a, b) => b.pnl_usd - a.pnl_usd);
    // the paper desk's own day movers, in the same shape: both desks show the
    // same block, each from its own book
    const paperDayTrades = todays
      .filter((t) => (t.mode || "paper") === "paper" && quoteOf(t.quote_asset) === "USD")
      .map((t) => ({
        symbol: t.symbol,
        side: t.side === "short" ? "short" : "long",
        pnl_usd: round(Number(t.pnl_usd) || 0),
        pnl_pct: round(Number(t.pnl_pct) || 0),
        exit_reason: t.exit_reason || null,
        closed_at: t.closed_at || null,
      }))
      .sort((a, b) => b.pnl_usd - a.pnl_usd);

    const exposure = positions.reduce((a, p) => a + p.size_usd, 0);
    const unrealized = positions.reduce((a, p) => a + p.pnl_usd, 0);
    // the Bitcoin the account holds, read from the freshest balance list this
    // cycle has: the account read just above when it succeeded, else the list
    // the Bitcoin legs already sized from — never a stored figure that predates
    // the buy, which is what showed a held Bitcoin as zero
    const btcHeld = pickBtcBalance(freshBalances && freshBalances.length ? freshBalances : btcBalances);

    // anchor the paper cash to the trades themselves: the original balance
    // plus everything booked minus what is deployed. Trusting the running
    // cash figure alone let it drift (overlapping cycles, balance resets
    // with positions open) and the desk quietly traded on money it didn't
    // have; anchored, equity always ties to booked profit exactly.
    // totals were fetched in the parallel stats read above
    const realizedTotal = (realizedAgg?.rows?.[0]?.sum_pnl_usd ?? 0) - (btcRealizedAgg?.rows?.[0]?.sum_pnl_usd ?? 0);
    const deployedTotal = (deployedAgg?.rows?.[0]?.sum_size_usd ?? 0) - (btcDeployedAgg?.rows?.[0]?.sum_size_usd ?? 0);
    const btcRealizedTotal = btcRealizedAgg?.rows?.[0]?.sum_pnl_usd ?? 0;
    const btcDeployedTotal = btcDeployedAgg?.rows?.[0]?.sum_size_usd ?? 0;
    // profit handling: compound rolls booked profit back into the trading
    // pool; stack sets profits aside so only the starting capital (plus any
    // accumulated losses) is at risk
    const stacked = Math.max(realizedTotal, 0);
    const anchoredCash =
      (config.profit_mode || "compound") === "stack"
        ? startBalance + (realizedTotal - stacked) - deployedTotal
        : startBalance + realizedTotal - deployedTotal;
    // equity ties directly to the money: starting balance plus everything
    // booked plus what the open positions are worth now. Mixing the in-loop
    // exposure with the aggregate understated equity whenever a position had
    // no live price (its size was subtracted but never added back).
    // NOTE (kept-sane guard): these equity/cash figures feed the desk panels
    // (EquityPanel.jsx, TodayProgress.jsx). The on-screen percent divides net
    // P&L by the first candle's open or the starting balance — NEVER by a
    // `|| 1` fallback, which once showed a bogus ±469% whenever a balance was
    // missing. After touching anything here, check both desk panels still
    // show sane percentages (paper and live) before shipping.
    const equity = startBalance + realizedTotal + unrealized;
    // the Bitcoin book anchors its own cash the same way: its starting bankroll
    // plus what it booked minus what it holds — never the dollar figures
    // the Bitcoin book's cash follows its own profit handling, as the dollar book's does
    const btcAnchoredCash = (paperBtcView.profit_mode || "compound") === "stack"
      ? btcStart + (btcRealizedTotal - Math.max(btcRealizedTotal, 0)) - btcDeployedTotal
      : btcStart + btcRealizedTotal - btcDeployedTotal;
    const btcUnrealized = positions
      .filter((p) => quoteOf(p.quote_asset) === "BTC")
      .reduce((a, p) => a + (Number(p.pnl_usd) || 0), 0);
    const btcEquity = btcStart + btcRealizedTotal + btcUnrealized;

    await base44.entities.BotConfig.update(config.id, {
      cash_balance: round(anchoredCash),
      btc_cash_balance: round(btcAnchoredCash),
      last_run_at: new Date().toISOString(),
    });

    // ---- save today's equity candle so the chart keeps its history even as
    // old trades age out of the journal
    const paperRealizedToday = realizedToday;
    // candles are per-user: one app user's equity chart must not overwrite
    // another's, so every write carries the owner and keys on owner + day
    const prevClose = prevCandles.length ? Number(prevCandles[0].close) : null;
    stage = "equity";
    const candleOpen = existingCandle
      ? Number(existingCandle.open)
      : prevClose != null
        ? prevClose
        : round(startBalance + realizedTotal - paperRealizedToday);
    const highBase = existingCandle ? Number(existingCandle.high) || candleOpen : candleOpen;
    const lowBase = existingCandle ? Number(existingCandle.low) || candleOpen : candleOpen;
    await base44.entities.EquityCandle.upsert(
      [
        {
          owner: user.id,
          day: todayKey,
          open: round(candleOpen),
          high: round(Math.max(highBase, candleOpen, equity)),
          low: round(Math.min(lowBase, candleOpen, equity)),
          close: round(equity),
          realized: round(paperRealizedToday),
          trades: paperTodays.length,
        },
      ],
      { key: ["owner", "day"] },
    );

    // ---- live desk equity candles: the same day-by-day history for real
    // trading, stored under a live-suffixed owner so the paper candles — and
    // the paper desk reset — stay untouched. Skipped when the exchange
    // balance could not be read this cycle, so stale figures never become
    // candle history.
    const liveEquityNow = exchangeBalance != null ? round(exchangeBalance + liveUnrealized) : null;
    if (liveEquityNow != null) {
      const liveOwner = `${user.id}|live`;
      const liveTodays = todays.filter((t) => (t.mode || "paper") === "real");
      const prevLiveClose = prevLiveCandles.length ? Number(prevLiveCandles[0].close) : null;
      const liveOpen = existingLive
        ? Number(existingLive.open)
        : prevLiveClose != null
          ? prevLiveClose
          : liveEquityNow;
      const liveHighBase = existingLive ? Number(existingLive.high) || liveOpen : liveOpen;
      const liveLowBase = existingLive ? Number(existingLive.low) || liveOpen : liveOpen;
      await base44.entities.EquityCandle.upsert(
        [
          {
            owner: liveOwner,
            day: todayKey,
            open: round(liveOpen),
            high: round(Math.max(liveHighBase, liveOpen, liveEquityNow)),
            low: round(Math.min(liveLowBase, liveOpen, liveEquityNow)),
            close: round(liveEquityNow),
            realized: round(liveRealized),
            trades: liveTodays.length,
          },
        ],
        { key: ["owner", "day"] },
      );
    }

    // the Bitcoin board's own top rows, in the shape the dollar board's are:
    // a desk showing the Bitcoin book shows these and never a dollar pick
    // a Bitcoin board's top rows, with the targets its own book trades by
    const btcTopOf = (board, engine) => ((board && board.rows) || []).slice(0, 12).map((r) => {
      const dist = (engine.marginOn ? 3 : 6) * Math.abs(r.entry - r.stop);
      const target =
        (engine.marginOn || engine.comboOn) && r.entry > 0 && r.stop > 0 && r.entry !== r.stop
          ? round(r.side === "long" ? r.entry + dist : r.entry - dist, 8)
          : r.target;
      return {
        ...r,
        target,
        pair: `${r.symbol}/XBT`,
        exchange: managed.conn ? managed.conn.exchange : null,
      };
    });
    const btcTopRows = btcTopOf(btcBoard, paperBtcEngine);
    // the same day movers, from the Bitcoin book's own trades
    const btcDayRow = (t) => ({
      symbol: t.symbol,
      side: t.side === "short" ? "short" : "long",
      pnl_usd: round(Number(t.pnl_usd) || 0),
      pnl_pct: round(Number(t.pnl_pct) || 0),
      exit_reason: t.exit_reason || null,
      closed_at: t.closed_at || null,
    });
    const btcPaperDay = todays
      .filter((t) => (t.mode || "paper") === "paper" && quoteOf(t.quote_asset) === "BTC")
      .sort((a, b) => (Number(b.pnl_usd) || 0) - (Number(a.pnl_usd) || 0));
    const liveBtcDay = liveBtcTodays
      .slice()
      .sort((a, b) => (Number(b.pnl_usd) || 0) - (Number(a.pnl_usd) || 0));

    return Response.json({
      mode: config.mode,
      closed,
      opened,
      proposed,
      positions,
      // the desk's top picks display the target the bot actually trades:
      // 6R from entry with the combo stack on, not the scan's raw level
      top: (board.rows || []).slice(0, 12).map((r) => {
        const dist = (paperEngine.marginOn ? 3 : 6) * Math.abs(r.entry - r.stop);
        const target =
          (paperEngine.marginOn || paperEngine.comboOn) && r.entry > 0 && r.stop > 0 && r.entry !== r.stop
            ? round(r.side === "long" ? r.entry + dist : r.entry - dist, 8)
            : r.target;
        return {
          ...r,
          target,
          pair: `${r.symbol}/${(managed.conn && (managed.conn.quoteAsset || QUOTE_ASSET[managed.conn.exchange])) || "USDT"}`,
          exchange: managed.conn ? managed.conn.exchange : null,
        };
      }),
      scanned: board.scannedCount,
      scan_log: scanLog,
      v3: v3Summary,
      btc_markets: {
        on: btcMarketsOn(paperView),
        live_on: btcMarketsOn(liveView),
        // the connected exchange that serves this book, and why it has nothing
        // to scan when no connected exchange lists Bitcoin markets
        venue: btcVenue ? btcVenue.exchange : null,
        venue_label: btcVenue ? btcVenue.label : null,
        venue_reason: btcVenue ? null : "No connected exchange lists Bitcoin markets",
        // a live Bitcoin entry is placed on the live connection, so the book
        // trades real money only when that account is the Bitcoin venue
        live_tradeable: liveBtcVenue,
        // why no live Bitcoin entry could fire this pass, or null when the road
        // was clear and the desk simply found nothing that qualified
        blocked_reason: btcBlocked,
        // the live Bitcoin book's own board, only when it scans differently
        live_board: liveBtcBoard && liveBtcBoard !== btcBoard
          ? {
              scanned: liveBtcBoard.scannedCount,
              universe: liveBtcBoard.universeCount,
              summary: liveBtcBoard.summary,
              median_change_24h: liveBtcBoard.medianChange24h,
              source: liveBtcBoard.source,
              top: btcTopOf(liveBtcBoard, liveBtcEngine),
            }
          : null,
        btc_usd: round(btcUsdNow, 2),
        scanned: btcBoard ? btcBoard.scannedCount : 0,
        universe: btcBoard ? btcBoard.universeCount : 0,
        v3: btcV3Summary,
        // the Bitcoin market's own board: its picks, its mood and its counts —
        // a desk showing this book shows these and nothing off the dollar board
        board: {
          scanned: btcBoard ? btcBoard.scannedCount : 0,
          universe: btcBoard ? btcBoard.universeCount : 0,
          summary: btcBoard ? btcBoard.summary : null,
          median_change_24h: btcBoard ? btcBoard.medianChange24h : 0,
          source: btcBoard ? btcBoard.source : "cache",
          top: btcTopRows,
        },
        // the Bitcoin book's own ledger: its own bankroll, its own cash, its own
        // open positions and its own brakes. Nothing here is shared with the
        // dollar figures above.
        book: {
          starting_balance: round(btcStart),
          cash: round(btcAnchoredCash),
          equity: round(btcEquity),
          realized_today: round(btcRealizedToday),
          realized_total: round(btcRealizedTotal),
          unrealized: round(btcUnrealized),
          open_paper: paperBtcOpen,
          open_live: liveBtcOpen,
          live_exposure: round(liveBtcExposure),
          live_unrealized: round(liveBtcUnrealized),
          live_realized_today: round(liveBtcRealizedToday),
          // the account's own Bitcoin: the funding this book spends, in bitcoin
          // and what it is worth at the live rate
          balance_btc: round(btcHeld, 8),
          balance_usd: round(btcHeld * btcUsdNow, 2),
          // the share of that holding this book may put to work, the hard cap it
          // must stay under, and the amount those two allow
          use_pct: btcUsePct,
          cap_btc: round(btcCapBtc, 8),
          usable_btc: round(btcSpendLimit(btcHeld, btcUsePct, btcCapBtc), 8),
          equity_usd: round(btcHeld * btcUsdNow + liveBtcUnrealized, 2),
          day_best: btcPaperDay.length ? btcDayRow(btcPaperDay[0]) : null,
          day_worst: btcPaperDay.length > 1 ? btcDayRow(btcPaperDay[btcPaperDay.length - 1]) : null,
          live_day_best: liveBtcDay.length ? btcDayRow(liveBtcDay[0]) : null,
          live_day_worst: liveBtcDay.length > 1 ? btcDayRow(liveBtcDay[liveBtcDay.length - 1]) : null,
          risk: btcRisk
            ? { block_entries: btcRisk.block_entries, size_multiplier: btcRisk.size_multiplier, reason: btcRisk.reason }
            : null,
        },
      },
      risk: paperRisk,
      diagnostics: { risk_error: riskError, v3_error: v3Error },
      rule_lock: deskDiag,
      universe: board.universeCount,
      summary: board.summary,
      median_change_24h: board.medianChange24h,
      // BTC's share of the board and which way it moved over the day, as this
      // cycle read it — the weight the alt entries carried
      dominance,
      source: board.source,
      cash: round(anchoredCash),
      profit_mode: config.profit_mode || "compound",
      stacked: round(stacked),
      exposure: round(exposure),
      unrealized: round(unrealized),
      equity: round(equity),
      realized_today: round(realizedToday),
      day_best: paperDayTrades[0] || null,
      day_worst: paperDayTrades.length > 1 ? paperDayTrades[paperDayTrades.length - 1] : null,
      daily_goal: round(goal),
      goal_hit: goalHit,
      live: {
        enabled: config.real_orders_enabled === true,
        paused: config.real_orders_enabled !== true,
        entry_ready: config.real_orders_enabled === true && live.conn != null && liveVerified,
        connection: managed.info
          ? {
              label: managed.info.label,
              exchange: managed.info.exchange,
              status: managed.info.status,
              status_message: managed.info.status_message,
              allow_trading: managed.info.allow_trading,
              last_checked_at: managed.info.last_checked_at,
              balance_usd: managed.info.balance_usd,
              balance_updated_at: managed.info.balance_updated_at,
            }
          : null,
        eligible_markets: eligibleCount,
        balance_usd: exchangeBalance,
        // the account's Bitcoin holding and what it is worth: the funding the
        // BTC markets spend, surfaced so it can be watched as it is bought
        btc_balance: round(btcHeld, 8),
        btc_balance_usd: round(btcHeld * btcUsdNow, 2),
        btc_rate: round(btcUsdNow, 2),
        balance_as_of: balanceAsOf,
        balance_stale: balanceStale,
        balance_error: balanceError,
        open_count: livePositions.length,
        cap_usd: liveBudgetCap,
        budget_left: liveBudgetCap > 0 ? round(Math.max(0, liveBudgetCap - liveExposure)) : null,
        exposure: round(liveExposure),
        unrealized: round(liveUnrealized),
        realized_today: round(liveRealized),
        daily_goal: liveGoal,
        goal_hit: liveGoal != null ? liveRealized >= liveGoal : false,
        day_best: liveDayTrades[0] || null,
        day_worst: liveDayTrades.length > 1 ? liveDayTrades[liveDayTrades.length - 1] : null,
        positions: livePositions,
      },
      sentiment: {
        checked: sentimentReads.size,
        flips: closed.filter((c) => c.exit_reason === "flipped").length,
        weakened: closed.filter((c) => c.exit_reason === "weakened").length,
      },
      wallet_sync: walletSync
        ? { imported: walletSync.imported.length, closed: walletSync.closed.length, adjusted: walletSync.adjusted.length, reason: walletSync.reason }
        : null,
      open_count: positions.length,
      config,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    const message = String((error && error.message) || error);
    return Response.json({ error: `${stage}: ${message}` }, { status: 500 });
  }
}