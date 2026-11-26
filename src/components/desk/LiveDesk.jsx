import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
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

// The live desk, laid out exactly as the paper desk is: the same four figures,
// the same progress bar, and the same top pick, equity chart, positions, smart
// money and market pulse in the same places. The only difference is the money —
// every figure here is exchange-reported or a confirmed real fill. What the live
// desk had beyond that (the connection, the pause control, the exchange's own
// counts and the day's movers) sits below the shared layout, so nothing is lost.
export default function LiveDesk({ bot, pulse, onClosePosition, onCloseAll, closingId, closingAll, onBackToPaper }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [toggling, setToggling] = useState(false);

  const live = bot?.live || {};
  const connection = live.connection;
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
  const liveEquity = balanceUsd != null ? (balanceUsd || 0) + (live.unrealized || 0) : null;
  const liveDayPct = Number(bot?.config?.live_rules?.daily_target_pct ?? bot?.config?.daily_target_pct) || 2;
  const goalPct = live.daily_goal ? ((Number(live.realized_today) || 0) / live.daily_goal) * 100 : 0;

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
            exchange and pair. Stops are software-monitored exits your rules execute each cycle.
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

      {live.balance_stale ? (
        <div className="rounded-xl border border-rose-400/30 bg-rose-400/5 p-3 text-[12px] text-rose-300">
          The last balance read failed — showing the saved balance
          {balanceAsOf ? ` from ${ago(balanceAsOf)}` : ''}
          . Figures below may be out of date. {live.balance_error || ''}
        </div>
      ) : null}

      {/* the four figures the paper desk leads with, on live money */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Equity"
          value={liveEquity == null ? '—' : fmtUsd(liveEquity)}
          sub="exchange balance plus unrealised"
          icon={Wallet}
        />
        <StatCard
          label="Today realised"
          value={fmtUsd(live.realized_today || 0)}
          sub={`${fmtPct(goalPct)} of your ${fmtUsd(live.daily_goal || 0)} target`}
          tone={(live.realized_today || 0) >= 0 ? 'up' : 'down'}
        />
        <StatCard
          label="Open positions"
          value={live.open_count ?? 0}
          sub={`${fmtUsd(live.exposure || 0)} deployed`}
          icon={Layers}
        />
        <StatCard
          label="Unrealised"
          value={fmtUsd(live.unrealized || 0)}
          sub={`${bot?.scanned || 0} coins scanned`}
          tone={(live.unrealized || 0) >= 0 ? 'up' : 'down'}
        />
      </div>

      <TodayProgress
        realizedToday={live.realized_today || 0}
        dailyGoal={live.daily_goal ?? 0}
        goalHit={live.goal_hit === true}
        openCount={live.open_count ?? 0}
        scanned={bot?.scanned || 0}
        startingBalance={balanceUsd || 0}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <TopPicks
            rows={bot?.top || []}
            positions={live.positions || []}
            targetPct={liveDayPct}
            onOpenChart={(symbol) => navigate(`/coin/${symbol}`)}
            onAnalyze={(symbol) => navigate(`/coin/${symbol}?ai=1`)}
          />

          <EquityPanel desk="live" startingBalance={balanceUsd || 0} dailyTargetPct={liveDayPct} liveEquity={liveEquity} />

          <PositionsPanel
            positions={live.positions || []}
            onClose={onClosePosition}
            onCloseAll={onCloseAll}
            closingId={closingId}
            closingAll={closingAll}
            hint="Your real positions on the exchange — each shows its exchange and pair. Closing sends a real sell order."
          />

          <SmartMoneyPanel />
        </div>

        <div className="min-w-0 space-y-4">
          <MarketPulse
            summary={pulse?.summary ?? bot?.summary}
            medianChange24h={pulse ? pulse.median_change_24h : bot?.median_change_24h}
            universe={pulse ? pulse.universe : bot?.universe}
            updatedAt={pulse ? pulse.updated_at : bot?.updated_at}
          />
        </div>
      </div>

      {/* live only, below the desk's shared layout: the exchange's own figures,
          the day's best and worst, and the last real closes */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="surface p-3">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Exchange balance</p>
          <p className="num mt-1 text-lg font-semibold">{balanceUsd != null ? fmtUsd(balanceUsd) : '—'}</p>
          <p className="text-[11px] text-muted-foreground">
            {balanceUsd != null ? `exchange-reported · saved ${ago(balanceAsOf)}` : 'unavailable — verify the connection'}
          </p>
        </div>
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

      <DayMovers best={live.day_best} worst={live.day_worst} />

      <RecentCloses mode="real" />
    </div>
  );
}
