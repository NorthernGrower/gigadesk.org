import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  Landmark,
  Layers,
  PauseCircle,
  PlayCircle,
  Wallet,
  XCircle,
} from 'lucide-react';
import StatCard from '@/components/common/StatCard';
import MarketPulse from '@/components/dashboard/MarketPulse';
import PositionsPanel from '@/components/dashboard/PositionsPanel';
import EquityPanel from '@/components/dashboard/EquityPanel';
import SmartMoneyPanel from '@/components/dashboard/SmartMoneyPanel';
import TodayProgress from '@/components/dashboard/TodayProgress';
import TopPicks from '@/components/desk/TopPicks';
import DayMovers from '@/components/desk/DayMovers';
import RecentCloses from '@/components/desk/RecentCloses';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { base44 } from '@/api/base44Client';
import useSavedBalance from '@/hooks/useSavedBalance';
import { emitBotTick, runBot } from '@/lib/market';
import { fmtPct, fmtUsd } from '@/lib/format';
import { formatDistanceToNowStrict } from 'date-fns';

const ago = (iso) => {
  if (!iso) return 'never';
  try {
    return `${formatDistanceToNowStrict(new Date(iso))} ago`;
  } catch {
    return 'unknown';
  }
};

// The live desk, laid out exactly as the paper desk is, showing one book at a
// time — the dollar market or the Bitcoin market, from the switch beside the
// desk switch. The book changes every figure on the page: its balance, its
// equity, its day, its positions, its top pick and its mood. In the Bitcoin
// book the balance is the Bitcoin the account holds with its dollar value, and
// its positions are the BTC-quoted ones, priced in bitcoin on their own pairs.
export default function LiveDesk({
  bot,
  pulse,
  book = 'USD',
  onClosePosition,
  onCloseAll,
  closingId,
  closingAll,
  onBackToPaper,
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [toggling, setToggling] = useState(false);

  const live = bot?.live || {};
  const connection = live.connection;
  const btc = bot?.btc_markets || {};
  const btcBook = btc.book || {};
  const btcBoard = btc.board || {};
  const btcMode = book === 'BTC';
  const staleScan = bot?.updated_at ? Date.now() - Date.parse(bot.updated_at) > 10 * 60000 : true;
  const connectionId = bot?.config?.real_connection_id || connection?.id || null;
  // a saved balance the desk keeps on the connection, refreshed every minute
  // so a failed live read never blanks the figure
  const savedBalance = useSavedBalance(connectionId, connection?.status);
  const balanceUsd =
    live.balance_usd != null
      ? live.balance_usd
      : savedBalance?.usd != null
        ? savedBalance.usd
        : connection?.balance_usd != null
          ? connection.balance_usd
          : null;
  const balanceAsOf =
    live.balance_as_of || savedBalance?.asOf || connection?.balance_updated_at || connection?.last_checked_at || null;
  const liveDayPct = Number(bot?.config?.live_rules?.daily_target_pct ?? bot?.config?.daily_target_pct) || 2;

  // one book on the page at a time: a position belongs to the book its own
  // quote names, so nothing here mixes the dollar book with the Bitcoin one
  const bookPositions = (live.positions || []).filter((p) =>
    btcMode ? p.quote_asset === 'BTC' : (p.quote_asset || 'USD') !== 'BTC',
  );
  const btcBalance = Number(btcBook.balance_btc) || Number(live.btc_balance) || 0;
  const btcBalanceUsd =
    btcBook.balance_usd != null ? Number(btcBook.balance_usd) : Number(live.btc_balance_usd) || 0;
  const btcRate = Number(btc.btc_usd) || Number(live.btc_rate) || 0;
  const btcDailyGoal = btcBalanceUsd > 0 ? (btcBalanceUsd * liveDayPct) / 100 : 0;
  const usdEquity = balanceUsd != null ? (balanceUsd || 0) + (live.unrealized || 0) : null;

  const view = btcMode
    ? {
        // the account's Bitcoin leads the Bitcoin book: what it holds, and what
        // that is worth at the live rate
        balanceLabel: 'Bitcoin balance',
        balanceValue: btcBalance > 0 ? `${btcBalance} BTC` : '0 BTC',
        balanceSub:
          btcRate > 0
            ? `${fmtUsd(btcBalanceUsd)} at ${fmtUsd(btcRate)}`
            : btcBalance > 0
              ? fmtUsd(btcBalanceUsd)
              : 'no Bitcoin on the account yet',
        equity: Number(btcBook.equity_usd) || btcBalanceUsd + (Number(btcBook.live_unrealized) || 0),
        realizedToday: Number(btcBook.live_realized_today) || 0,
        openCount: Number(btcBook.open_live) || 0,
        unrealized: Number(btcBook.live_unrealized) || 0,
        exposure: Number(btcBook.live_exposure) || 0,
        dailyGoal: btcDailyGoal,
        goalHit: btcDailyGoal > 0 && (Number(btcBook.live_realized_today) || 0) >= btcDailyGoal,
        startingBalance: btcBalanceUsd,
        top: btcBoard.top || [],
        summary: btcBoard.summary || null,
        medianChange24h: btcBoard.median_change_24h || 0,
        universe: btcBoard.universe || 0,
        scanned: btcBoard.scanned || 0,
        dayBest: btcBook.live_day_best,
        dayWorst: btcBook.live_day_worst,
      }
    : {
        balanceLabel: 'Exchange balance',
        balanceValue: balanceUsd != null ? fmtUsd(balanceUsd) : '—',
        balanceSub:
          balanceUsd != null
            ? `exchange-reported · saved ${ago(balanceAsOf)}`
            : 'unavailable — verify the connection',
        equity: usdEquity,
        realizedToday: Number(live.realized_today) || 0,
        openCount: live.open_count ?? 0,
        unrealized: Number(live.unrealized) || 0,
        exposure: Number(live.exposure) || 0,
        dailyGoal: live.daily_goal ?? 0,
        goalHit: live.goal_hit === true,
        startingBalance: balanceUsd || 0,
        top: bot?.top || [],
        summary: pulse?.summary ?? bot?.summary,
        medianChange24h: pulse ? pulse.median_change_24h : bot?.median_change_24h,
        universe: pulse ? pulse.universe : bot?.universe,
        scanned: bot?.scanned || 0,
        dayBest: live.day_best,
        dayWorst: live.day_worst,
      };
  const goalPct = view.dailyGoal ? (view.realizedToday / view.dailyGoal) * 100 : 0;

  const setPaused = async (paused) => {
    setToggling(true);
    try {
      if (bot?.config?.id) {
        await base44.entities.BotConfig.update(bot.config.id, { real_orders_enabled: !paused });
      }
      const fresh = await runBot(true);
      emitBotTick(fresh);
      toast({
        title: paused ? 'Live trading paused' : 'Live trading enabled',
        description: paused
          ? 'New live entries are stopped. Open real positions are still managed by your rules.'
          : 'Qualifying setups will now send real market orders to your exchange.',
      });
    } finally {
      setToggling(false);
    }
  };

  const connPill = () => {
    if (!connection)
      return (
        <Link to="/settings" className="flex items-center gap-1.5 text-[11px] text-amber-300 hover:underline">
          <XCircle className="h-3.5 w-3.5" /> No verified exchange — connect one in Settings
        </Link>
      );
    if (connection.status !== 'connected')
      return (
        <span className="flex items-center gap-1.5 text-[11px] text-rose-300">
          <XCircle className="h-3.5 w-3.5" /> {connection.label}: {connection.status_message || connection.status}
        </span>
      );
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" /> {connection.label}
        {connection.allow_trading ? '' : ' (view only)'} · synced {ago(connection.last_checked_at)}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      {/* live only: the connection behind every figure on this page, and the
          double-confirmed control over whether new real orders may fire */}
      <div className="surface flex flex-wrap items-center justify-between gap-3 border-amber-400/20 p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-300 ring-1 ring-amber-400/30">
              Live desk
            </span>
            {connPill()}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Balances are exchange-reported, positions come from confirmed fills, and every position shows its
            exchange and pair. Stops are software-monitored exits your rules execute each cycle — and a breached
            stop or the per-trade loss cap is closed within five minutes by the desk guard, even while the app is
            closed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {live.paused ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" className="bg-emerald-500/90 text-black hover:bg-emerald-400" disabled={toggling}>
                  <PlayCircle className="h-4 w-4" /> Enable live trading
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Enable live trading?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Qualifying setups will send real market orders on{' '}
                    {connection?.label || 'your connected exchange'} under your risk rules and budget cap. New
                    entries stop the moment you pause again.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => setPaused(false)}>Enable</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive" disabled={toggling}>
                  <PauseCircle className="h-4 w-4" /> Pause live trading
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Pause live trading?</AlertDialogTitle>
                  <AlertDialogDescription>
                    New live entries stop immediately. Nothing is sold — your open real positions keep being
                    managed by your stop, target and sentiment rules.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => setPaused(true)}>Pause entries</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onBackToPaper}>
            Back to Paper
          </Button>
        </div>
      </div>

      {!btcMode && live.balance_stale ? (
        <div className="rounded-xl border border-rose-400/30 bg-rose-400/5 p-3 text-[12px] text-rose-300">
          The last balance read failed — showing the saved balance
          {balanceAsOf ? ` from ${ago(balanceAsOf)}` : ''}
          . Figures below may be out of date. {live.balance_error || ''}
        </div>
      ) : null}

      {/* the money the bot can actually spend leads the desk: in the Bitcoin
          book that is the Bitcoin the account holds, with its dollar value */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label={view.balanceLabel}
          value={view.balanceValue}
          sub={view.balanceSub}
          icon={btcMode ? Wallet : Landmark}
        />
        <StatCard
          label="Equity"
          value={view.equity == null ? '—' : fmtUsd(view.equity)}
          sub={btcMode ? 'Bitcoin value plus unrealised' : 'exchange balance plus unrealised'}
          icon={Wallet}
        />
        <StatCard
          label="Today realised"
          value={fmtUsd(view.realizedToday)}
          sub={`${fmtPct(goalPct)} of your ${fmtUsd(view.dailyGoal || 0)} target`}
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

      {!btcMode ? (
        <div className="surface flex flex-wrap items-center justify-between gap-3 p-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              BTC on the exchange
            </p>
            <p className="num mt-1 text-lg font-semibold">
              {btcBalance > 0 ? `${btcBalance} BTC` : '0 BTC'}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {btcBalance > 0 ? fmtUsd(btcBalanceUsd) : '$0.00'}
              {btcRate ? ` at ${fmtUsd(btcRate)}` : ''} · the funding BTC-quoted markets spend
            </p>
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
              btc.live_on ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
            }`}
          >
            {btc.live_on ? 'BTC markets on' : 'BTC markets off'}
          </span>
        </div>
      ) : null}

      <TodayProgress
        realizedToday={view.realizedToday}
        dailyGoal={view.dailyGoal ?? 0}
        goalHit={view.goalHit}
        openCount={view.openCount}
        scanned={view.scanned}
        startingBalance={view.startingBalance || 0}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <TopPicks
            rows={view.top}
            positions={bookPositions}
            targetPct={liveDayPct}
            onOpenChart={(symbol) => navigate(`/coin/${symbol}`)}
            onAnalyze={(symbol) => navigate(`/coin/${symbol}?ai=1`)}
          />

          {btcMode ? (
            // the Bitcoin book has no equity chart of the account's own, and the
            // dollar one is a different book's line: its account is summarised
            // here instead
            <div className="surface p-4">
              <p className="text-[10px] uppercase tracking-[0.16em] text-amber-300">Bitcoin account</p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Bitcoin held</p>
                  <p className="num mt-1 text-base font-semibold">
                    {btcBalance > 0 ? `${btcBalance} BTC` : '0 BTC'}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Worth</p>
                  <p className="num mt-1 text-base font-semibold">{fmtUsd(btcBalanceUsd)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Deployed</p>
                  <p className="num mt-1 text-base font-semibold">{fmtUsd(view.exposure)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Positions</p>
                  <p className="num mt-1 text-base font-semibold">{view.openCount}</p>
                </div>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                The Bitcoin book spends only the Bitcoin on the account, never the dollar cash. Its positions are
                priced in BTC on their own pairs, so its dollar figures are each pair's own move at the rate.
              </p>
            </div>
          ) : (
            <EquityPanel
              desk="live"
              startingBalance={view.startingBalance || 0}
              dailyTargetPct={liveDayPct}
              liveEquity={usdEquity}
            />
          )}

          <PositionsPanel
            positions={bookPositions}
            onClose={onClosePosition}
            onCloseAll={onCloseAll}
            closingId={closingId}
            closingAll={closingAll}
            hint={
              btcMode
                ? 'Your real Bitcoin-market positions — each is priced in BTC on its own pair. Closing sends a real sell on that pair.'
                : 'Your real positions on the exchange — each shows its exchange and pair. Closing sends a real sell order.'
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

      {/* live only, below the desk's shared layout: the exchange's own counts,
          the day's best and worst, and the last real closes */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="surface p-3">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Eligible markets</p>
          <p className="num mt-1 text-lg font-semibold">
            {live.eligible_markets != null ? live.eligible_markets.toLocaleString() : '—'}
          </p>
          <p className="text-[11px] text-muted-foreground">
            active pairs verified on {connection?.label || 'the exchange'}
          </p>
        </div>
        <div className="surface p-3">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Last scan</p>
          <p className={`num mt-1 text-lg font-semibold ${staleScan ? 'text-amber-300' : ''}`}>{ago(bot?.updated_at)}</p>
          <p className="text-[11px] text-muted-foreground">
            {staleScan ? 'stale — waiting on the next full cycle' : 'fresh'}
          </p>
        </div>
      </div>

      <DayMovers best={view.dayBest} worst={view.dayWorst} />

      <RecentCloses mode="real" quote={book} />
    </div>
  );
}
