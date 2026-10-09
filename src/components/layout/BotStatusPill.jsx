import React, { useEffect, useState } from 'react';
import { Loader2, Play, Power } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MODE_LABEL, requestBotRun } from '@/lib/market';
import { timeAgo } from '@/lib/format';

export default function BotStatusPill({ config, running }) {
  const [lastRun, setLastRun] = useState(config?.last_run_at || null);

  useEffect(() => {
    setLastRun(config?.last_run_at || lastRun);
  }, [config?.last_run_at]);

  useEffect(() => {
    const onTick = (event) => {
      if (event.detail?.updated_at) setLastRun(event.detail.updated_at);
    };
    window.addEventListener('bot:tick', onTick);
    return () => window.removeEventListener('bot:tick', onTick);
  }, []);

  const mode = config?.mode || 'approve';

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
      <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={requestBotRun} disabled={running}>
        {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
        Run now
      </Button>
      {!running ? <Power className="hidden h-3.5 w-3.5 text-muted-foreground sm:block" /> : null}
    </div>
  );
}