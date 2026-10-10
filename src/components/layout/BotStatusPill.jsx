import React, { useEffect, useState } from 'react';
import { Loader2, Play, SlidersHorizontal } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { base44 } from '@/api/base44Client';
import { MODE_LABEL, ensureBotConfig, pageItems, requestBotRun } from '@/lib/market';
import { timeAgo } from '@/lib/format';

export default function BotStatusPill({ config, running }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [lastRun, setLastRun] = useState(config?.last_run_at || null);
  const [override, setOverride] = useState(null);

  useEffect(() => {
    setLastRun(config?.last_run_at || lastRun);
  }, [config?.last_run_at]);

  useEffect(() => {
    setOverride(null);
  }, [config?.mode, config?.real_orders_enabled]);

  useEffect(() => {
    const onTick = (event) => {
      if (event.detail?.updated_at) setLastRun(event.detail.updated_at);
    };
    window.addEventListener('bot:tick', onTick);
    return () => window.removeEventListener('bot:tick', onTick);
  }, []);

  const cfg = { ...config, ...override };
  const mode = cfg?.mode || 'approve';
  const liveOn = cfg?.real_orders_enabled === true;

  const toggleAuto = async () => {
    const base = config || (await ensureBotConfig().catch(() => null));
    if (!base) {
      toast({ title: 'Could not load the bot rules', variant: 'destructive' });
      return;
    }
    const goingAuto = base.mode !== 'auto';
    const patch = goingAuto ? { mode: 'auto', auto_run: true } : { mode: 'approve' };
    try {
      await base44.entities.BotConfig.update(base.id, patch);
      setOverride(patch);
      toast({
        title: goingAuto ? 'Bot is running in auto mode' : 'Auto paused — back to approving each trade',
      });
      requestBotRun();
    } catch (err) {
      toast({ title: 'Could not change the mode', description: err.message, variant: 'destructive' });
    }
  };

  const toggleLive = async () => {
    const base = config || (await ensureBotConfig().catch(() => null));
    if (!base) {
      toast({ title: 'Could not load the bot rules', variant: 'destructive' });
      return;
    }
    const goingLive = base.real_orders_enabled !== true;
    try {
      if (goingLive) {
        const ready = pageItems(
          await base44.entities.ExchangeConnection.filter({ status: 'connected', allow_trading: true }, { limit: 5 }),
        );
        if (!ready.length) {
          toast({
            title: 'Live trading needs a verified exchange',
            description: 'Connect an exchange on the Exchanges page and enable trading first.',
            variant: 'destructive',
          });
          return;
        }
        const conn = ready.find((c) => c.id === base.real_connection_id) || ready[0];
        await base44.entities.BotConfig.update(base.id, {
          real_orders_enabled: true,
          real_connection_id: conn.id,
        });
        toast({
          title: 'Live mode on',
          description: `Qualifying longs are sent as real orders to ${conn.label || conn.exchange}.`,
        });
      } else {
        await base44.entities.BotConfig.update(base.id, { real_orders_enabled: false });
        toast({ title: 'Back to paper trading' });
      }
      setOverride({ real_orders_enabled: goingLive });
      requestBotRun();
    } catch (err) {
      toast({ title: 'Could not change the mode', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="flex items-center gap-2">
      <span className="hidden items-center gap-1.5 rounded-full border border-border/70 bg-secondary/30 px-2.5 py-1 text-[11px] text-muted-foreground sm:flex">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            mode === 'auto' ? 'bg-primary' : mode === 'approve' ? 'bg-amber-300' : 'bg-muted-foreground'
          }`}
        />
        {MODE_LABEL[mode]}
        {lastRun ? <span className="text-muted-foreground/70">· {timeAgo(lastRun)}</span> : null}
      </span>

      <div className="flex items-center rounded-lg border border-border/70 bg-secondary/40 p-0.5">
        <button
          type="button"
          onClick={toggleLive}
          title={liveOn ? 'Trading in live mode on your exchange' : 'Paper mode — no real orders are sent'}
          className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
            liveOn ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/30' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {liveOn ? 'Live' : 'Paper'}
        </button>
      </div>

      <button
        type="button"
        onClick={toggleAuto}
        title={mode === 'auto' ? 'The bot opens and closes trades on its own' : 'Set the bot running in auto mode'}
        className={`rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors ${
          mode === 'auto'
            ? 'border-primary/40 bg-primary/15 text-primary'
            : 'border-border/70 bg-secondary/40 text-muted-foreground hover:text-foreground'
        }`}
      >
        {mode === 'auto' ? 'Auto on' : 'Auto'}
      </button>

      <Button
        size="sm"
        variant="outline"
        className="h-8 text-[11px]"
        onClick={() => navigate('/bot')}
        title="Bot rules and settings"
      >
        <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
        Rules
      </Button>

      <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={requestBotRun} disabled={running}>
        {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
        Run now
      </Button>
    </div>
  );
}