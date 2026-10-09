import React from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ScoreBadge from '@/components/common/ScoreBadge';
import { VERDICT_LABEL } from '@/lib/market';
import { fmtPct, fmtPrice } from '@/lib/format';

function Level({ label, value, tone }) {
  const tones = {
    entry: 'text-foreground',
    target: 'text-primary',
    stop: 'text-destructive',
  };
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`num mt-1 text-sm font-medium ${tones[tone] || ''}`}>{value}</p>
    </div>
  );
}

export default function AnalysisPanel({ snapshot, analysis, loading, onGenerate }) {
  if (!snapshot) return null;
  const levels = analysis
    ? { entry: analysis.entry, target: analysis.target, stop: analysis.stop }
    : { entry: snapshot.entry, target: snapshot.target, stop: snapshot.stop };

  return (
    <div className="surface flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Read on this setup</p>
          <div className="mt-1 flex items-center gap-2">
            <ScoreBadge verdict={snapshot.verdict} score={snapshot.score} />
            <span className="num text-xs text-muted-foreground">confidence {snapshot.confidence}%</span>
          </div>
        </div>
        <Button size="sm" variant={analysis ? 'outline' : 'default'} onClick={onGenerate} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />}
          {analysis ? 'Refresh read' : 'Generate AI read'}
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        <Level label="Entry" value={fmtPrice(levels.entry)} tone="entry" />
        <Level label="Target" value={fmtPrice(levels.target)} tone="target" />
        <Level label="Stop" value={fmtPrice(levels.stop)} tone="stop" />
      </div>

      {snapshot.reasons?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {snapshot.reasons.map((reason) => (
            <span
              key={reason}
              className="rounded-full border border-border/70 bg-secondary/30 px-2.5 py-1 text-[11px] text-muted-foreground"
            >
              {reason}
            </span>
          ))}
        </div>
      ) : null}

      {analysis ? (
        <div className="space-y-3 border-t border-border/60 pt-3">
          <p className="text-sm leading-relaxed text-foreground/90">{analysis.thesis}</p>
          {analysis.setup_quality ? (
            <p className="text-xs text-muted-foreground">{analysis.setup_quality}</p>
          ) : null}
          {analysis.risks ? (
            <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.14em] text-destructive">Main risks</p>
              <p className="mt-1 text-xs leading-relaxed text-foreground/80">{analysis.risks}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[11px] text-muted-foreground">
            <span>
              AI verdict <span className="text-foreground">{VERDICT_LABEL[analysis.verdict] || analysis.verdict}</span>
            </span>
            <span>
              Confidence <span className="num text-foreground">{Math.round(analysis.confidence)}%</span>
            </span>
            {analysis.horizon ? (
              <span>
                Horizon <span className="text-foreground">{analysis.horizon}</span>
              </span>
            ) : null}
            {analysis.invalidation ? (
              <span>
                Invalid below <span className="text-foreground">{analysis.invalidation}</span>
              </span>
            ) : null}
            <span className="num">
              needs {fmtPct(snapshot.required_move_pct, 1)} to target · {snapshot.risk_reward}:1
            </span>
          </div>
        </div>
      ) : (
        <p className="border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
          The mechanical read above is always available. Generate the AI read for a written thesis on whether
          this setup is worth taking, where it fails, and what could go wrong.
        </p>
      )}
    </div>
  );
}