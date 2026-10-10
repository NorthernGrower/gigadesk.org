import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers, Wallet } from 'lucide-react';
import AlertsFeed from '@/components/dashboard/AlertsFeed';
import BestBuyCard from '@/components/dashboard/BestBuyCard';
import BestWorstPositions from '@/components/dashboard/BestWorstPositions';
import EquityPanel from '@/components/dashboard/EquityPanel';
import MarketPulse from '@/components/dashboard/MarketPulse';
import PositionsPanel from '@/components/dashboard/PositionsPanel';
import SmartMoneyPanel from '@/components/dashboard/SmartMoneyPanel';
import TodayProgress from '@/components/dashboard/TodayProgress';
import StatCard from '@/components/common/StatCard';
import { ErrorNotice, LoadingBlock } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { onTradesChange } from '@/lib/live';
import { emitBotTick, requestBotRun, runBot, tradeAction } from '@/lib/market';
import { fmtUsd } from '@/lib/format';

export default function Dashboard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [bot, setBot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [closingId, setClosingId] = useState(null);
  const [closingAll, setClosingAll] = useState(false);
  const [deskMode, setDeskMode] = useState('paper');

  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const data = await runBot(false);
        if (alive) setBot(data);
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        if (alive) setLoading(false);
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
      }));
      // hold the loading state until a full scan reports, so the desk never flashes
      // "no setup" while the first market scan is still running
      if (data.summary) setLoading(false);
    };

    load();
    window.addEventListener('bot:tick', onTick);

    // live stats: a changed trade refreshes the desk (a cooldown keeps the
    // bot's own mark-to-market writes from fanning out into more runs)
    let lastLiveRefresh = 0;
    const stopLive = onTradesChange(() => {
      if (Date.now() - lastLiveRefresh < 15000) return;
      lastLiveRefresh = Date.now();
      runBot(true)
        .then((data) => {
          if (alive) setBot(data);
        })
        .catch(() => {});
    });

    return () => {
      alive = false;
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

  if (loading) return <LoadingBlock label="Scanning the whole market for the best setups" />;

  const top = bot?.top?.[0];
  const config = bot?.config;
  const goalPct = bot?.daily_goal ? (bot.realized_today / bot.daily_goal) * 100 : 0;

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
              onClick={() => setDeskMode(opt.value)}
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
        {deskMode === 'live' && !bot?.live?.enabled ? (
          <span className="text-[11px] text-muted-foreground">
            Live orders are off — flip the Paper/Live switch in the header to route the bot to your exchange.
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {deskMode === 'live' ? (
          <>
            <StatCard
              label="Exchange balance"
              value={bot?.live?.balance_usd != null ? fmtUsd(bot.live.balance_usd) : '—'}
              sub={bot?.live?.connection ? bot.live.connection.label : 'Verified exchange needed to refresh'}
              icon={Wallet}
            />
            <StatCard
              label="Today realised"
              value={fmtUsd(bot?.live?.realized_today || 0)}
              sub="closed real trades today"
              tone={(bot?.live?.realized_today || 0) >= 0 ? 'up' : 'down'}
            />
            <StatCard
              label="Open positions"
              value={bot?.live?.open_count ?? 0}
              sub={`${fmtUsd(bot?.live?.exposure || 0)} deployed`}
              icon={Layers}
            />
            <StatCard
              label="Unrealised"
              value={fmtUsd(bot?.live?.unrealized || 0)}
              sub="marked to market every cycle"
              tone={(bot?.live?.unrealized || 0) >= 0 ? 'up' : 'down'}
            />
          </>
        ) : (
          <>
            <StatCard label="Equity" value={fmtUsd(bot?.equity || 0)} sub={`${fmtUsd(bot?.cash || 0)} free cash`} icon={Wallet} />
            <StatCard
              label="Today realised"
              value={fmtUsd(bot?.realized_today || 0)}
              sub={`${goalPct.toFixed(0)}% of your ${fmtUsd(bot?.daily_goal || 0)} target`}
              tone={(bot?.realized_today || 0) >= 0 ? 'up' : 'down'}
            />
            <StatCard
              label="Open positions"
              value={bot?.open_count ?? 0}
              sub={`${fmtUsd(bot?.exposure || 0)} deployed`}
              icon={Layers}
            />
            <StatCard
              label="Unrealised"
              value={fmtUsd(bot?.unrealized || 0)}
              sub={`${bot?.scanned || 0} coins scanned`}
              tone={(bot?.unrealized || 0) >= 0 ? 'up' : 'down'}
            />
          </>
        )}
      </div>

      <TodayProgress
        realizedToday={bot?.realized_today || 0}
        dailyGoal={bot?.daily_goal || 0}
        goalHit={bot?.goal_hit}
        openCount={bot?.open_count}
        scanned={bot?.scanned}
        startingBalance={Number(config?.starting_balance) || 10000}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          {top ? (
            <BestBuyCard
              row={top}
              targetPct={Number(config?.daily_target_pct) || 2}
              onOpenChart={() => navigate(`/coin/${top.symbol}`)}
              onAnalyze={() => navigate(`/coin/${top.symbol}?ai=1`)}
            />
          ) : (
            <BestWorstPositions
              positions={deskMode === 'live' ? bot?.live?.positions || [] : bot?.positions || []}
            />
          )}

          <EquityPanel
            startingBalance={Number(config?.starting_balance) || 10000}
            dailyTargetPct={Number(config?.daily_target_pct) || 2}
            liveEquity={bot?.equity}
          />

          <PositionsPanel
            positions={deskMode === 'live' ? bot?.live?.positions || [] : bot?.positions || []}
            onClose={closePosition}
            onCloseAll={closeAll}
            closingId={closingId}
            closingAll={closingAll}
            hint={
              deskMode === 'live'
                ? 'Your real positions on the exchange, marked to market every cycle.'
                : 'Live profit and loss, marked to market every cycle.'
            }
          />

          <SmartMoneyPanel />
        </div>

        <div className="min-w-0 space-y-4">
          <MarketPulse
            summary={bot?.summary}
            medianChange24h={bot?.median_change_24h}
            universe={bot?.universe}
            updatedAt={bot?.updated_at}
          />
          <AlertsFeed limit={8} />
        </div>
      </div>
    </div>
  );
}