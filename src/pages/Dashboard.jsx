import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers, Radar, Wallet } from 'lucide-react';
import AlertsFeed from '@/components/dashboard/AlertsFeed';
import BestBuyCard from '@/components/dashboard/BestBuyCard';
import EquityPanel from '@/components/dashboard/EquityPanel';
import MarketPulse from '@/components/dashboard/MarketPulse';
import PositionsPanel from '@/components/dashboard/PositionsPanel';
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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {top ? (
            <BestBuyCard
              row={top}
              targetPct={Number(config?.daily_target_pct) || 2}
              onOpenChart={() => navigate(`/coin/${top.symbol}`)}
              onAnalyze={() => navigate(`/coin/${top.symbol}?ai=1`)}
            />
          ) : (
            <div className="surface p-6">
              <p className="font-heading text-base font-medium">No qualifying setup right now</p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Nothing in the scanned market clears your score and target bars at the moment. Lower the minimum score
                in the bot rules, or rescan in a few minutes.
              </p>
              <Button className="mt-4" size="sm" onClick={requestBotRun}>
                <Radar className="mr-2 h-3.5 w-3.5" /> Rescan the market
              </Button>
            </div>
          )}

          <PositionsPanel
            positions={bot?.positions || []}
            onClose={closePosition}
            onCloseAll={closeAll}
            closingId={closingId}
            closingAll={closingAll}
            hint="Live profit and loss, marked to market every cycle."
          />
        </div>

        <div className="space-y-4">
          <MarketPulse
            summary={bot?.summary}
            medianChange24h={bot?.median_change_24h}
            universe={bot?.universe}
            updatedAt={bot?.updated_at}
          />
          <EquityPanel
            startingBalance={Number(config?.starting_balance) || 10000}
            dailyTargetPct={Number(config?.daily_target_pct) || 2}
          />
          <AlertsFeed limit={8} />
        </div>
      </div>
    </div>
  );
}