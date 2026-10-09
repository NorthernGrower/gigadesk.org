import React from 'react';

const TONES = {
  neutral: 'text-foreground',
  up: 'text-primary',
  down: 'text-destructive',
  accent: 'text-accent',
};

export default function StatCard({ label, value, sub, tone = 'neutral', icon: Icon }) {
  return (
    <div className="surface px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </p>
        {Icon ? <Icon className="h-3.5 w-3.5 text-muted-foreground" /> : null}
      </div>
      <p className={`num mt-2 text-xl font-semibold ${TONES[tone] || TONES.neutral}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}