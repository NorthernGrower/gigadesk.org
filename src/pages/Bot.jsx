import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import PositionsPanel from '@/components/dashboard/PositionsPanel';
import BotControls from '@/components/bot/BotControls';
import ProposedTrades from '@/components/bot/ProposedTrades';
import RiskSettings from '@/components/bot/RiskSettings';
import LearnedPanel from '@/components/bot/LearnedPanel';
import { ErrorNotice, LoadingBlock } from '@/components/common/States';
import { useToast } from '@/components/ui/use-toast';
import { fmtUsd } from '@/lib/format';
import useSavedBalance from '@/hooks/useSavedBalance';
import { onTradesChange } from '@/lib/live';
import { emitBotTick, ensureBotConfig, getLastBot, pageItems, runBot, tradeAction } from '@/lib/market';

export default function Bot() {
  const { toast } = useToast();
  const [config, setConfig] = useState(null);
  const [bot, setBot] = useState(null);
  const [proposed, setProposed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [closingId, setClosingId] = useState(null);
  const [closingAll, setClosingAll] = useState(false);
  const [error, setError] = useState(null);

  // live-desk balance mechanism: the saved connection balance, re-read from
  // the exchange every minute — light bot cycles never refresh it themselves
  const connectionId = bot?.config?.real_connection_id || bot?.live?.connection?.id || null;
  const savedBalance = useSavedBalance(connectionId, bot?.live?.connection?.status);

  const loadProposed = async () => {
    const rows = pageItems(await base44.entities.Trade.filter({ status: 'proposed' }, { sort: '-created_date', limit: 30 }));
    setProposed(rows);
  };

  const cycle = async (light = false) => {
    setRunning(true);
    setError(null);
    try {
      const data = await runBot(light);
      setBot(data);
      if (data.config) setConfig(data.config);
      await loadProposed();
      emitBotTick(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      // revisits render the last cycle immediately; the light refresh below updates it
      const cached = getLastBot();
      if (cached) {
        setBot(cached);
        if (cached.config) setConfig(cached.config);
        setLoading(false);
      }
      try {
        const cfg = await ensureBotConfig();
        if (!alive) return;
        setConfig(cfg);
      } catch (err) {
        if (alive) setError(err.message);
      }
      cycle(true);
    })();

    const onTick = (event) => {
      const data = event.detail;
      if (!data) return;
      setBot(data);
      if (data.config) setConfig(data.config);
      loadProposed();
      setRunning(false);
    };
    window.addEventListener('bot:tick', onTick);

    // live updates: a changed trade refreshes positions and proposals
    // (a cooldown keeps the bot's own mark-to-market writes from fanning out)
    let lastLiveRefresh = 0;
    const stopLive = onTradesChange(() => {
      if (Date.now() - lastLiveRefresh < 15000) return;
      lastLiveRefresh = Date.now();
      runBot(true)
        .then((data) => {
          if (!alive) return;
          setBot(data);
          if (data.config) setConfig(data.config);
          loadProposed();
        })
        .catch(() => {});
    });

    return () => {
      alive = false;
      window.removeEventListener('bot:tick', onTick);
      stopLive();
    };
  }, []);

  const changeMode = async (mode) => {
    try {
      await base44.entities.BotConfig.update(config.id, { mode });
      setConfig((prev) => ({ ...prev, mode }));
      toast({ title: `Bot set to ${mode === 'auto' ? 'fully automatic' : mode === 'approve' ? 'approve each trade' : 'signals only'}` });
    } catch (err) {
      toast({ title: 'Could not change the mode', description: err.message, variant: 'destructive' });
    }
  };

  const toggleAutoRun = async (value) => {
    try {
      await base44.entities.BotConfig.update(config.id, { auto_run: value });
      setConfig((prev) => ({ ...prev, auto_run: value }));
    } catch (err) {
      toast({ title: 'Could not update the schedule', description: err.message, variant: 'destructive' });
    }
  };

  const handleProposal = async (action, tradeId) => {
    setBusyId(tradeId);
    try {
      await tradeAction(action, tradeId);
      toast({ title: action === 'approve' ? 'Position opened' : 'Proposal skipped' });
      await cycle(true);
    } catch (err) {
      toast({ title: 'Could not update the proposal', description: err.message, variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  const closePosition = async (position) => {
    setClosingId(position.id);
    try {
      await tradeAction('close', position.id);
      await cycle(true);
    } catch (err) {
      toast({ title: 'Could not close the position', description: err.message, variant: 'destructive' });
    } finally {
      setClosingId(null);
    }
  };

  const closeAll = async () => {
    setClosingAll(true);
    try {
      const result = await tradeAction('close_all');
      toast({
        title: result.closed ? `Closed ${result.closed} position${result.closed === 1 ? '' : 's'}` : 'Nothing to close',
        description: result.closed ? `${fmtUsd(result.pnl_usd)} booked into your journal` : undefined,
      });
      await cycle(true);
    } catch (err) {
      toast({ title: 'Could not close every position', description: err.message, variant: 'destructive' });
    } finally {
      setClosingAll(false);
    }
  };

  if (loading && !bot) return <LoadingBlock label="Loading bot stats and rules" />;

  // the page follows the desk: the paper desk shows paper stats and paper
  // positions, the live desk keeps its exchange-reported view
  const desk = config?.active_desk === 'live' ? 'live' : 'paper';

  return (
    <div className="space-y-4">
      {error ? <ErrorNotice message={error} onRetry={() => cycle(false)} /> : null}

      <BotControls
        config={config}
        running={running}
        onModeChange={changeMode}
        onToggleAutoRun={toggleAutoRun}
        onRunNow={() => cycle(false)}
        desk={desk}
        stats={
          desk === 'paper'
            ? {
                balance: bot?.cash,
                exposure: bot?.exposure,
                unrealized: bot?.unrealized,
                realizedToday: bot?.realized_today,
                dailyGoal: bot?.daily_goal,
                openCount: bot?.open_count,
                scanned: bot?.scanned,
              }
            : {
                balance: savedBalance?.usd != null ? savedBalance.usd : bot?.live?.balance_usd,
                balanceStale: bot?.live?.balance_stale && savedBalance?.usd == null,
                balanceError: bot?.live?.balance_error,
                exposure: bot?.live?.exposure,
                cap: bot?.live?.cap_usd,
                budget: bot?.live?.budget_left,
                unrealized: bot?.live?.unrealized,
                realizedToday: bot?.live?.realized_today,
                openCount: bot?.live?.open_count,
                scanned: bot?.scanned,
                enabled: bot?.live?.enabled,
              }
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <ProposedTrades trades={proposed} onAction={handleProposal} busyId={busyId} />
          <PositionsPanel
            title={desk === 'paper' ? 'Paper positions' : 'Live positions'}
            positions={desk === 'paper' ? bot?.positions || [] : bot?.live?.positions || []}
            onClose={closePosition}
            onCloseAll={closeAll}
            closingId={closingId}
            closingAll={closingAll}
            hint={
              desk === 'paper'
                ? 'Open paper positions, marked to market every cycle.'
                : 'Exchange-reported live positions, marked to market every cycle.'
            }
          />
        </div>
        <div className="space-y-4">
          <LearnedPanel />
          <div id="risk-rules">
            <RiskSettings config={config} onSaved={() => cycle(true)} desk={desk} />
          </div>
        </div>
      </div>
    </div>
  );
}