import React from 'react';
import { VERDICT_LABEL } from '@/lib/market';

const TONES = {
  strong_long: 'bg-primary/15 text-primary border-primary/40',
  long: 'bg-primary/10 text-primary border-primary/25',
  watch: 'bg-amber-400/10 text-amber-300 border-amber-400/25',
  short: 'bg-destructive/10 text-destructive border-destructive/25',
  strong_short: 'bg-destructive/15 text-destructive border-destructive/40',
  avoid: 'bg-muted text-muted-foreground border-border',
};

export default function ScoreBadge({ verdict = 'watch', score, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        TONES[verdict] || TONES.avoid
      } ${className}`}
    >
      <span className="num font-semibold">{Math.round(Number(score) || 0)}</span>
      <span className="opacity-80">{VERDICT_LABEL[verdict] || 'Watch'}</span>
    </span>
  );
}