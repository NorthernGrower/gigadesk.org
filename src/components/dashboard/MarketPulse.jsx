import React from 'react';
import { Activity, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { fmtPct } from '@/lib/format';

function Metric({ label, value, tone, hint }) {
  const tones = { up: 'text-primary', down: 'text-destructive', neutral: 'text-foreground' };
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`num mt-1 text-lg font-semibold ${tones[tone] || tones.neutral}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default function MarketPulse({ summary, medianChange24h, universe, updatedAt }) {
  if (!summary) {
    return (
      <div className="surface p-4">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Market pulse</p>
        <p className="mt-3 text-sm text-muted-foreground">
          Reading the whole market — the first scan lands in a moment.
        </p>
      </div>
    );
  }

  const advancing = summary.advancing || 0;
  const declining = summary.declining || 0;
  const total = Math.max(1, advancing + declining);
  const breadth = Math.round((advancing / total) * 100);

  return (
    <div className="surface space-y-4 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Market pulse</p>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Activity className="h-3.5 w-3.5" />
          {updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
        </span>
      </div>

      <div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1 text-primary">
            <ArrowUpRight className="h-3.5 w-3.5" /> {advancing} up
          </span>
          <span className="flex items-center gap-1 text-destructive">
            <ArrowDownRight className="h-3.5 w-3.5" /> {declining} down
          </span>
        </div>
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-destructive/30">
          <div className="h-full rounded-full bg-primary" style={{ width: `${breadth}%` }} />
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {breadth}% of {universe || total} tracked markets are green today
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 border-t border-border/60 pt-3 sm:grid-cols-4">
        <Metric label="Median 24h" value={fmtPct(medianChange24h)} tone={medianChange24h >= 0 ? 'up' : 'down'} />
        <Metric label="Avg score" value={summary.avg_score} hint="across scanned coins" />
        <Metric label="Strong longs" value={summary.strong_longs} tone="up" hint="score 70+" />
        <Metric label="Strong shorts" value={summary.strong_shorts} tone="down" hint="score 70+" />
      </div>

      <p className="text-[11px] text-muted-foreground">
        {summary.meeting_target} ranked setups clear your daily target bar with a score above 62.
      </p>
    </div>
  );
}