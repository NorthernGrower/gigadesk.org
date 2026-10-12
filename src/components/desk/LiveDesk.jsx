import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  CheckCircle2,
  Landmark,
  PauseCircle,
  PlayCircle,
  Wallet,
  XCircle,
} from 'lucide-react';
import StatCard from '@/components/common/StatCard';
import PositionsPanel from '@/components/dashboard/PositionsPanel';
import EquityPanel from '@/components/dashboard/EquityPanel';
import TodayProgress from '@/components/dashboard/TodayProgress';
import LiveSignals from '@/components/desk/LiveSignals';
import DayMovers from '@/components/desk/DayMovers';
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
import { emitBotTick, runBot } from '@/lib/market';
import { fmtUsd } from '@/lib/format';
import { formatDistanceToNowStrict } from 'date-fns';

const ago = (iso) => {
  if (!iso) return 'never';
  try {
    return `${formatDistanceToNowStrict(new Date(iso))} ago`;
  } catch {
    return 'unknown';
  }
};

export default function LiveDesk({ bot, onClosePosition, onCloseAll, closingId, closingAll, onBackToPaper }) {
  const { toast } = useToast();
  const [toggling, setToggling] = useState(false);
  const [recent, setRecent] = useState([]);
  // the top setup stays on the desk at all times: hold the last one the scan
  // ranked first, and on a fresh load fall back to the newest stored signal
  const [heldSetup, setHeldSetup] = useState(null);
  const [fallbackSetup, setFallbackSetup] = useState(null);
  useEffect(() => {
    const fresh = bot?.top?.[0];
    if (fresh) setHeldSetup(fresh);
  }, [bot?.top]);
  useEffect(() => {
    if (bot?.top?.length || heldSetup) return undefined;
    let alive = true;
    base44.entities.Signal.filter({ status: 'new' }, { sort: '-detected_at', limit: 1 })
      .then((page) => {
        if (alive && page.items?.[0]) setFallbackSetup(page.items[0]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bot?.top, heldSetup]);
  const topSetup = bot?.top?.[0] || heldSetup || fallbackSetup || null;
  // a saved balance the desk keeps on the connection, refreshed every minute
  // so a failed live read never blanks the figure
  const [savedBalance, setSavedBalance] = useState(null);
  const live = bot?.live || {};
  const connection = live.connection;
  const staleScan = bot?.updated_at ? Date.now() - Date.parse(bot.updated_at) > 10 * 60000 : true;
  const connectionId = bot?.config?.real_connection_id || connection?.id || null;
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

  // an errored or locked key is checked on demand only: Kraken counts every
  // failed signed read toward its temporary lockout, so a timer that keeps
  // verifying a dead connection would keep re-arming the lock
  const statusRef = useRef(connection?.status);
  statusRef.current = connection?.status;
  useEffect(() => {
    if (!connectionId) return undefined;
    let alive = true;
    const check = async () => {
      if (statusRef.current && statusRef.current !== 'connected') return;
      try {
        const res = await base44.functions.invoke('checkExchangeConnection', { id: connectionId });
        const conn = res.data?.connection;
        if (alive && conn && conn.balance_usd != null) {
          setSavedBalance({ usd: conn.balance_usd, asOf: conn.balance_updated_at });
        }
      } catch {
        // a failed check keeps the last saved figure
      }
    };
    check();
    const timer = setInterval(check, 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [connectionId, connection?.status]);

  useEffect(() => {
    let alive = true;
    base44.entities.Trade.filter({ mode: 'real', status: 'closed' }, { sort: '-closed_at', limit: 6 })
      .then((page) => {
        if (alive) setRecent(page.items || []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label="Equity"
          value={balanceUsd != null ? fmtUsd((balanceUsd || 0) + (live.unrealized || 0)) : '—'}
          sub="exchange balance plus unrealised P&L"
          icon={Wallet}
        />
        <StatCard
          label="Exchange balance"
          value={balanceUsd != null ? fmtUsd(balanceUsd) : '—'}
          sub={
            balanceUsd != null
              ? `exchange-reported · saved ${ago(balanceAsOf)}`
              : 'unavailable — verify the connection'
          }
          icon={Landmark}
        />
        <StatCard
          label="Open positions"
          value={live.open_count ?? 0}
          sub={`${fmtUsd(live.exposure || 0)} deployed${live.cap_usd ? ` of ${fmtUsd(live.cap_usd)} cap` : ''}`}
          icon={Activity}
        />
        <StatCard
          label="Unrealised"
          value={fmtUsd(live.unrealized || 0)}
          sub="marked to market every cycle"
          tone={(live.unrealized || 0) >= 0 ? 'up' : 'down'}
        />
        <StatCard
          label="Today realised"
          value={fmtUsd(live.realized_today || 0)}
          sub="closed real trades today"
          tone={(live.realized_today || 0) >= 0 ? 'up' : 'down'}
        />
      </div>

      <EquityPanel
        desk="live"
        startingBalance={Number(live.balance_usd) || 0}
        dailyTargetPct={
          Number(bot?.config?.live_rules?.daily_target_pct ?? bot?.config?.daily_target_pct) || 2
        }
        liveEquity={live.balance_usd != null ? (live.balance_usd || 0) + (live.unrealized || 0) : null}
      />

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
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Scanned last cycle</p>
          <p className="num mt-1 text-lg font-semibold">{bot?.scanned ?? '—'}</p>
          <p className="text-[11px] text-muted-foreground">analysed with the current engine</p>
        </div>
        <div className="surface p-3">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Last scan</p>
          <p className={`num mt-1 text-lg font-semibold ${staleScan ? 'text-amber-300' : ''}`}>{ago(bot?.updated_at)}</p>
          <p className="text-[11px] text-muted-foreground">
            {staleScan ? 'stale — waiting on the next full cycle' : 'fresh'}
          </p>
        </div>
      </div>

      <TodayProgress
        realizedToday={live.realized_today || 0}
        dailyGoal={live.daily_goal ?? 0}
        goalHit={live.goal_hit === true}
        openCount={live.open_count ?? 0}
        scanned={bot?.scanned || 0}
        startingBalance={balanceUsd || 0}
      />

      <LiveSignals
        rows={topSetup ? [topSetup] : []}
        exchange={connection?.label}
        held={!bot?.top?.length}
      />

      <PositionsPanel
        positions={live.positions || []}
        onClose={onClosePosition}
        onCloseAll={onCloseAll}
        closingId={closingId}
        closingAll={closingAll}
        hint="Your real positions on the exchange — each shows its exchange and pair. Closing sends a real sell order."
      />

      <DayMovers best={live.day_best} worst={live.day_worst} />

      {recent.length ? (
        <div className="surface p-4">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Recent closed live trades</p>
          <div className="mt-2 space-y-1.5">
            {recent.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="flex items-center gap-2">
                  <span className="font-semibold">{t.symbol}</span>
                  <span className="num text-[11px] text-muted-foreground">
                    {t.exchange ? `${t.exchange} · ` : ''}
                    {t.exchange_order_id ? `order ${String(t.exchange_order_id).slice(0, 10)}…` : 'logged by hand'}
                  </span>
                </span>
                <span className={`num ${Number(t.pnl_usd) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {fmtUsd(t.pnl_usd)} ({t.pnl_pct ?? 0}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}