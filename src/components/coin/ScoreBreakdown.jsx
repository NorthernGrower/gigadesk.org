import React from 'react';

const DESKS = [
  { key: 'trend', label: 'Trend & structure', weight: 30 },
  { key: 'momentum', label: 'Momentum', weight: 22 },
  { key: 'volume', label: 'Volume flow', weight: 19 },
  { key: 'location', label: 'Entry location', weight: 19 },
  { key: 'volatility', label: 'Risk & tradability', weight: 10 },
];

function tone(score) {
  if (score >= 70) return 'bg-primary';
  if (score >= 55) return 'bg-accent';
  if (score >= 40) return 'bg-muted-foreground/70';
  return 'bg-destructive';
}

/** How the composite score was built, desk by desk. */
export default function ScoreBreakdown({ categories, confluence, quality }) {
  if (!categories) return null;

  return (
    <div className="surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Score breakdown</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Weighted across five desks — each one scored from its own tools.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {quality ? (
            <span>
              Quality <span className="num text-foreground">{quality}</span>
            </span>
          ) : null}
          {confluence != null ? (
            <span>
              Confluence <span className="num text-foreground">{confluence}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {DESKS.map((desk) => {
          const value = Number(categories[desk.key]) || 0;
          return (
            <div key={desk.key} className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-[11px] text-muted-foreground">{desk.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border/60">
                <div className={`h-full rounded-full ${tone(value)}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
              </div>
              <span className="num w-8 shrink-0 text-right text-[11px] text-foreground">{value}</span>
              <span className="num w-8 shrink-0 text-right text-[10px] text-muted-foreground">{desk.weight}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}