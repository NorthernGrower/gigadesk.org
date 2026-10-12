import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { base44 } from '@/api/base44Client';
import { MODE_LABEL, ensureBotConfig, requestBotRun } from '@/lib/market';
import { timeAgo } from '@/lib/format';

export default function BotStatusPill({ config, running }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [lastRun, setLastRun] = useState(config?.last_run_at || null);
  const [override, setOverride] = useState(null);
  // which desk the user is on: the pill always shows the OTHER desk, so
  // clicking it takes you there instead of touching live trading
  const [desk, setDesk] = useState(config?.active_desk === 'live' ? 'live' : 'paper');

  useEffect(() => {
    setLastRun(config?.last_run_at || lastRun);
  }, [config?.last_run_at]);

  useEffect(() => {
    setOverride(null);
  }, [config?.mode]);

  useEffect(() => {
    if (config?.active_desk === 'live' || config?.active_desk === 'paper') setDesk(config.active_desk);
  }, [config?.active_desk]);

  useEffect(() => {
    const onDeskChange = (event) => {
      if (event.detail === 'live' || event.detail === 'paper') setDesk(event.detail);
    };
    window.addEventListener('desk:changed', onDeskChange);
    return () => window.removeEventListener('desk:changed', onDeskChange);
  }, []);

  useEffect(() => {
    const onTick = (event) => {
      if (event.detail?.updated_at) setLastRun(event.detail.updated_at);
    };
    window.addEventListener('bot:tick', onTick);
    return () => window.removeEventListener('bot:tick', onTick);
  }, []);

  const cfg = { ...config, ...override };
  const mode = cfg?.mode || 'approve';

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

      <button
        type="button"
        onClick={() => navigate(`/dashboard?desk=${desk === 'paper' ? 'live' : 'paper'}`)}
        title={desk === 'paper' ? 'Open the Live Desk' : 'Back to the Paper Desk'}
        className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
          desk === 'paper'
            ? 'border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20'
            : 'border-border/70 bg-secondary/40 text-muted-foreground hover:text-foreground'
        }`}
      >
        {desk === 'paper' ? 'Live' : 'Paper'}
      </button>

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

      <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={requestBotRun} disabled={running}>
        {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
        Run now
      </Button>
    </div>
  );
}