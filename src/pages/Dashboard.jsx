import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Layers, Wallet } from 'lucide-react';
import TopPicks from '@/components/desk/TopPicks';
import EquityPanel from '@/components/dashboard/EquityPanel';
import MarketPulse from '@/components/dashboard/MarketPulse';
import PositionsPanel from '@/components/dashboard/PositionsPanel';
import SmartMoneyPanel from '@/components/dashboard/SmartMoneyPanel';
import TodayProgress from '@/components/dashboard/TodayProgress';
import LiveDesk from '@/components/desk/LiveDesk';
import BookSwitch from '@/components/desk/BookSwitch';
import { bookRuleSet } from '@/lib/bookRules';
import DayMovers from '@/components/desk/DayMovers';
import RecentCloses from '@/components/desk/RecentCloses';
import StatCard from '@/components/common/StatCard';
import { ErrorNotice, LoadingBlock } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/use-toast';
import { base44 } from '@/api/base44Client';
import { onTradesChange } from '@/lib/live';
import { emitBotTick, getLastBot, getLastPulse, lastBotAgeMs, rememberPulse, requestBotRun, runBot, scanMarket, tradeAction, withPreviousBoard } from '@/lib/market';
import { fmtUsd, fmtPct } from '@/lib/format';

export default function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const [bot, setBot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [closingId, setClosingId] = useState(null);
  const [closingAll, setClosingAll] = useState(false);
  const botRef = useRef(null);
  const [deskMode, setDeskMode] = useState('paper');
  // which book the page shows: the dollar market or the Bitcoin market. The two
  // are separate books, so this is not a filter — every figure follows it.
  const [bookMode, setBookMode] = useState('USD');
  const [confirmLive, setConfirmLive] = useState(false);
  // the market pulse refreshes on its own schedule (every 15 minutes), so its
  // stats never depend on when the bot's own cycle last scanned
  const [pulse, setPulse] = useState(null);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      // any earlier scan (this session or the last one) renders immediately
      const cached = getLastBot(Number.POSITIVE_INFINITY);
      if (cached) {
        setBot(cached);
        if (cached?.config?.active_desk === 'live' || cached?.config?.active_desk === 'paper') {
          setDeskMode(cached.config.active_desk);
        }
        setLoading(false);
      }

      // the desk never waits on a full cycle — a full cycle scans 60 coins,
      // re-reads open charts and syncs the exchange, which is why the desk
      // used to sit on its spinner. The fast pass returns positions and
      // stats in seconds; the board refreshes quietly behind it.
      const apply = (data, full) => {
        if (!alive) return;
        setBot((prev) =>
          full || !prev
            ? { ...data, btc_markets: withPreviousBoard(data.btc_markets, prev?.btc_markets) }
            : {
                ...data,
                top: data.top?.length ? data.top : prev?.top || [],
                summary: data.summary ? data.summary : prev?.summary || null,
                universe: data.universe || prev?.universe || 0,
                median_change_24h: data.summary ? data.median_change_24h : prev?.median_change_24h ?? 0,
                scanned: data.scanned || prev?.scanned || 0,
                // a light pass carries no Bitcoin board: the book keeps the
                // last scan's picks instead of going blank on every refresh
                btc_markets: withPreviousBoard(data.btc_markets, prev?.btc_markets),
              },
        );
        const desk = data?.config?.active_desk;
        if (desk === 'live' || desk === 'paper') setDeskMode(desk);
        // the saved book follows a full cycle only: a fast pass can return the
        // config a click just wrote, and flipping the page back under the
        // reader would be worse than waiting one cycle for it
        if (full) setBookMode(data?.config?.active_book === 'BTC' ? 'BTC' : 'USD');
      };

      runBot(true)
        .then((data) => apply(data, false))
        .catch((err) => {
          if (alive && !cached) setError(err.message);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
      // a full cycle scans 60 coins and takes the server up to a minute —
      // only launch one when the board is actually stale. The header runner
      // refreshes it every five minutes anyway, so revisiting the desk
      // within that window must not relaunch the minute-long scan.
      if (lastBotAgeMs() > 240000) {
        runBot(false)
          .then((data) => apply(data, true))
          .catch(() => {});
      }
    };

    const onTick = (event) => {
      const data = event.detail;
      if (!data) return;
      setBot((prev) => ({
        ...data,
        top: data.top?.length ? data.top : prev?.top || [],
        summary: data.summary || prev?.summary || null,
        universe: data.universe || prev?.universe || 0,
        median_change_24h: data.summary ? data.median_change_24h : prev?.median_change_24h ?? 0,
        scanned: data.scanned || prev?.scanned || 0,
        btc_markets: withPreviousBoard(data.btc_markets, prev?.btc_markets),
      }));
      // hold the loading state until a full scan reports, so the desk never flashes
      // "no setup" while the first market scan is still running
      if (data.summary) setLoading(false);
    };

    // market pulse: one scan right away (so the box shows stats even when the
    // bot cycle has none) and again every 15 minutes
    let alive2 = true;
    const refreshPulse = async () => {
      const cfg = botRef.current?.config;
      // the last pulse (15-minute life) survives page changes and reloads:
      // revisiting the desk re-renders it instead of rescanning the market
      const cachedPulse = getLastPulse();
      if (cachedPulse) {
        setPulse(cachedPulse);
        return;
      }
      try {
        const board = await scanMarket({
          timeframe: cfg?.timeframe || '1h',
          scope: cfg?.market_cap_scope || 'all',
          dailyTargetPct: Number(cfg?.daily_target_pct) || 2,
        });
        const next = {
          summary: board.summary || null,
          median_change_24h: board.medianChange24h,
          universe: board.universeCount,
          updated_at: new Date().toISOString(),
        };
        if (alive2) setPulse(next);
        rememberPulse(next);
      } catch (err) {
        // the last pulse stays on screen until the next scheduled refresh
      }
    };
    refreshPulse();
    const pulseTimer = setInterval(refreshPulse, 15 * 60 * 1000);

    load();
    window.addEventListener('bot:tick', onTick);

    // live stats: a changed trade refreshes the desk (a cooldown keeps the
    // bot's own mark-to-market writes from fanning out into more runs)
    let lastLiveRefresh = 0;
    const stopLive = onTradesChange(() => {
      if (Date.now() - lastLiveRefresh < 30000) return;
      lastLiveRefresh = Date.now();
      runBot(true)
        .then((data) => {
          if (alive) setBot(data);
        })
        .catch(() => {});
    });

    return () => {
      alive = false;
      alive2 = false;
      clearInterval(pulseTimer);
      window.removeEventListener('bot:tick', onTick);
      stopLive();
    };
  }, []);

  const closePosition = async (position) => {
    setClosingId(position.id);
    try {
      await tradeAction('close', position.id);
      const fresh = await runBot(true);
      setBot(fresh);
      emitBotTick(fresh);
    } catch (err) {
      setError(err.message);
    } finally {
      setClosingId(null);
    }
  };

  const closeAll = async () => {
    setClosingAll(true);
    try {
      const result = await tradeAction('close_all');
      const fresh = await runBot(true);
      setBot(fresh);
      emitBotTick(fresh);
      toast({
        title: result.closed ? `Closed ${result.closed} position${result.closed === 1 ? '' : 's'}` : 'Nothing to close',
        description: result.closed ? `${fmtUsd(result.pnl_usd)} booked into your journal` : undefined,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setClosingAll(false);
    }
  };

  const persistDesk = (desk) => {
    setDeskMode(desk);
    window.dispatchEvent(new CustomEvent('desk:changed', { detail: desk }));
    if (bot?.config?.id) {
      base44.entities.BotConfig.update(bot.config.id, { active_desk: desk }).catch(() => {});
    }
  };

  // the header's Live/Paper button lands here with ?desk= — take it straight
  // to that desk (viewing the desk is safe, so no confirmation) and clean the
  // param so a later refresh follows the saved desk again
  useEffect(() => {
    const desk = new URLSearchParams(location.search).get('desk');
    if (desk !== 'live' && desk !== 'paper') return;
    // wait for the bot rules to land before switching: switching earlier gets
    // overridden when the load() below re-applies the saved desk
    if (!bot?.config?.id) return;
    navigate('/dashboard', { replace: true });
    if (deskMode !== desk) persistDesk(desk);
  }, [location.search, bot?.config?.id, deskMode]);

  const switchDesk = (desk) => {
    if (desk === 'live' && deskMode !== 'live') {
      setConfirmLive(true);
      return;
    }
    persistDesk(desk);
  };

  // the book is the page's own view, saved with the desk so a reload and a
  // second device come back to the same one. It changes every figure on the
  // page: the two books share a journal, never a set of numbers.
  const persistBook = (book) => {
    const next = book === 'BTC' ? 'BTC' : 'USD';
    setBookMode(next);
    if (bot?.config?.id) {
      const patch = { active_book: next };
      base44.entities.BotConfig.update(bot.config.id, patch).catch(() => {});
    }
  };

  botRef.current = bot;

  if (loading)
    return (
      <LoadingBlock label="Setting up your desk — loading positions, setups and the market pulse" />
    );

  const config = bot?.config;
  const btcMode = bookMode === 'BTC';
  const btc = bot?.btc_markets || {};
  const btcBook = btc.book || {};
  const btcBoard = btc.board || {};
  const btcRate = Number(btc.btc_usd) || 0;
  // the Bitcoin book's free cash, in the currency it trades and in dollars
  const btcCashBtc = btcRate > 0 ? (Number(btcBook.cash) || 0) / btcRate : null;
  // one book on the page at a time: the dollar book or the Bitcoin book, never
  // a mixture. A position belongs to the book its own quote names.
  const bookPositions = (bot?.positions || []).filter((p) =>
    btcMode ? p.quote_asset === 'BTC' : (p.quote_asset || 'USD') !== 'BTC',
  );
  const dailyTargetPct = Number(config?.daily_target_pct) || 2;
  // the Bitcoin book has its own daily target, so its goal is measured by its own rule
  const btcTargetPct = Number(bookRuleSet(config, 'paper', 'BTC')?.daily_target_pct) || 2;
  const btcDailyGoal = ((Number(btcBook.starting_balance) || 0) * btcTargetPct) / 100;
  const view = btcMode
    ? {
        equity: btcBook.equity || 0,
        cash: btcBook.cash || 0,
        realizedToday: btcBook.realized_today || 0,
        unrealized: btcBook.unrealized || 0,
        openCount: btcBook.open_paper || 0,
        exposure: bookPositions.reduce((a, p) => a + (Number(p.size_usd) || 0), 0),
        startingBalance: btcBook.starting_balance || 0,
        startingBtc: Number(btcBook.starting_btc) > 0
          ? Number(btcBook.starting_btc)
          : Number(bot?.btc_markets?.btc_usd) > 0
            ? (Number(btcBook.starting_balance) || 0) / Number(bot.btc_markets.btc_usd)
            : null,
        dailyGoal: btcDailyGoal,
        goalHit: btcDailyGoal > 0 && (btcBook.realized_today || 0) >= btcDailyGoal,
        scanned: btcBoard.scanned || 0,
        summary: btcBoard.summary || null,
        medianChange24h: btcBoard.median_change_24h || 0,
        universe: btcBoard.universe || 0,
        top: btcBoard.top || [],
        dayBest: btcBook.day_best,
        dayWorst: btcBook.day_worst,
        realizedTotal: btcBook.realized_total || 0,
      }
    : {
        equity: bot?.equity || 0,
        cash: bot?.cash || 0,
        realizedToday: bot?.realized_today || 0,
        unrealized: bot?.unrealized || 0,
        openCount: bot?.open_count || 0,
        exposure: bot?.exposure || 0,
        startingBalance: Number(config?.starting_balance) || 10000,
        dailyGoal: bot?.daily_goal || 0,
        goalHit: bot?.goal_hit === true,
        scanned: bot?.scanned || 0,
        summary: pulse?.summary ?? bot?.summary,
        medianChange24h: pulse ? pulse.median_change_24h : bot?.median_change_24h,
        universe: pulse ? pulse.universe : bot?.universe,
        top: bot?.top || [],
        dayBest: bot?.day_best,
        dayWorst: bot?.day_worst,
        realizedTotal: null,
      };
  const goalPct = view.dailyGoal ? (view.realizedToday / view.dailyGoal) * 100 : 0;

  return (
    <div className="space-y-4">
      {error ? <ErrorNotice message={error} onRetry={requestBotRun} /> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-secondary/40 p-0.5">
          {[
            { value: 'paper', label: 'Paper' },
            { value: 'live', label: 'Live' },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => switchDesk(opt.value)}
              className={`rounded-lg px-3 py-1.5 text-[11px] transition-colors ${
                deskMode === opt.value
                  ? opt.value === 'live'
                    ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/30'
                    : 'bg-primary/15 text-primary ring-1 ring-primary/30'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {deskMode === 'live' && bot?.live?.paused ? (
            <span className="text-[11px] text-muted-foreground">
              Live trading is paused — new live entries are stopped, open real positions stay managed.
            </span>
          ) : null}
          {/* the book switch, on the right of the desk switch: it changes
              every figure below it, never a filter over one set of numbers */}
          <BookSwitch value={bookMode} onChange={persistBook} />
        </div>
      </div>

      {deskMode === 'live' ? (
        <LiveDesk
          bot={bot}
          pulse={pulse}
          book={bookMode}
          onClosePosition={closePosition}
          onCloseAll={closeAll}
          closingId={closingId}
          closingAll={closingAll}
          onBackToPaper={() => persistDesk('paper')}
        />
      ) : (
        <>
          {/* every figure below follows the switch: the dollar book or the
              Bitcoin book, never a mixture of the two */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Equity"
              value={fmtUsd(view.equity)}
              sub={`${fmtUsd(view.cash)} free cash`}
              icon={Wallet}
            />
            <StatCard
              label="Today realised"
              value={fmtUsd(view.realizedToday)}
              sub={`${fmtPct(goalPct)} of your ${fmtUsd(view.dailyGoal)} target`}
              tone={view.realizedToday >= 0 ? 'up' : 'down'}
            />
            <StatCard
              label="Open positions"
              value={view.openCount}
              sub={`${fmtUsd(view.exposure)} deployed`}
              icon={Layers}
            />
            <StatCard
              label="Unrealised"
              value={fmtUsd(view.unrealized)}
              sub={`${view.scanned || 0} coins scanned`}
              tone={view.unrealized >= 0 ? 'up' : 'down'}
            />
          </div>

          <TodayProgress
            realizedToday={view.realizedToday}
            dailyGoal={view.dailyGoal}
            goalHit={view.goalHit}
            openCount={view.openCount}
            scanned={view.scanned}
            startingBalance={view.startingBalance}
          />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-4">
              <TopPicks
                rows={view.top}
                positions={bookPositions}
                targetPct={dailyTargetPct}
                onOpenChart={(symbol) => navigate(`/coin/${symbol}${btcMode ? '?quote=BTC' : ''}`)}
                onAnalyze={(symbol) => navigate(`/coin/${symbol}?ai=1${btcMode ? '&quote=BTC' : ''}`)}
              />

              {btcMode ? (
                // the Bitcoin book has no equity chart of its own, and the
                // dollar one would be a different book's line: its ledger is
                // shown here instead, labelled as its own
                <div className="surface p-4">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-amber-300">
                    Bitcoin book
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Bankroll</p>
                      <p className="num mt-1 text-base font-semibold">
                        {view.startingBtc != null ? `${Number(view.startingBtc).toFixed(6).replace(/\.?0+$/, '')} BTC` : fmtUsd(view.startingBalance)}
                      </p>
                      {view.startingBtc != null ? (
                        <p className="num mt-0.5 text-[11px] font-normal text-muted-foreground">{fmtUsd(view.startingBalance)} at the live rate</p>
                      ) : null}
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Free cash</p>
                      <p className="num mt-1 text-base font-semibold">
                        {btcCashBtc != null
                          ? `${Number(btcCashBtc).toFixed(6).replace(/\.?0+$/, '')} BTC`
                          : fmtUsd(view.cash)}
                      </p>
                      {btcCashBtc != null ? (
                        <p className="num mt-0.5 text-[11px] font-normal text-muted-foreground">
                          {fmtUsd(view.cash)} at {fmtUsd(btcRate)}/BTC
                        </p>
                      ) : null}
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Realised (all)</p>
                      <p className={`num mt-1 text-base font-semibold ${Number(view.realizedTotal) >= 0 ? 'text-primary' : 'text-destructive'}`}>
                        {fmtUsd(view.realizedTotal || 0)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Open positions</p>
                      <p className="num mt-1 text-base font-semibold">{view.openCount}</p>
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                    This is the Bitcoin book's own ledger — its own bankroll, cash, positions and results.
                    The dollar book's equity chart is not shown here, because it is a different book's line.
                  </p>
                </div>
              ) : (
                <EquityPanel
                  startingBalance={view.startingBalance}
                  dailyTargetPct={dailyTargetPct}
                  liveEquity={bot?.equity}
                />
              )}

              <PositionsPanel
                positions={bookPositions}
                onClose={closePosition}
                onCloseAll={closeAll}
                closingId={closingId}
                closingAll={closingAll}
                hint={
                  btcMode
                    ? 'Bitcoin-market positions only, marked to market every cycle. Each is priced in BTC on its own pair.'
                    : 'Live profit and loss, marked to market every cycle.'
                }
              />

              <SmartMoneyPanel />
            </div>

            <div className="min-w-0 space-y-4">
              <MarketPulse
                summary={view.summary}
                medianChange24h={view.medianChange24h}
                universe={view.universe}
                updatedAt={pulse && !btcMode ? pulse.updated_at : bot?.updated_at}
              />
            </div>
          </div>

          {/* the same two blocks the live desk closes with, so the desks show
              the same items end to end */}
          <DayMovers best={view.dayBest} worst={view.dayWorst} />
          <RecentCloses mode="paper" quote={bookMode} />
        </>
      )}

      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to the Live Desk?</AlertDialogTitle>
            <AlertDialogDescription>
              This desk shows your exchange-reported balances and confirmed real positions. New live entries only
              fire while live trading is enabled on the desk — enabling it places real market orders on your
              connected exchange. Your Paper Desk and its history stay untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay on Paper</AlertDialogCancel>
            <AlertDialogAction onClick={() => persistDesk('live')}>Open Live Desk</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}