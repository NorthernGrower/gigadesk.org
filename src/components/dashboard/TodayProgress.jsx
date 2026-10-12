import React from 'react';
import { fmtPct, fmtUsd } from '@/lib/format';

export default function TodayProgress({ realizedToday, dailyGoal, goalHit, openCount, scanned, startingBalance }) {
  const goalPct = dailyGoal ? Math.max(0, Math.min(100, (realizedToday / dailyGoal) * 100)) : 0;

  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Today's progress to your target</span>
        <span className="num">{goalPct.toFixed(0)}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border/60">
        <div
          className={`h-full rounded-full transition-all ${goalHit ? 'bg-primary' : 'bg-accent'}`}
          style={{ width: `${goalPct}%` }}
        />
      </div>
      {goalHit ? (
        // NOTE: keep the startingBalance > 0 guard — a `|| 1` fallback here
        // once showed a bogus ±469% percent when no balance was loaded.
        <p className="mt-1.5 text-[11px] text-primary">
          {startingBalance > 0
            ? `Target reached today — ${fmtPct((realizedToday / startingBalance) * 100)} on the balance.`
            : 'Target reached today.'}
        </p>
      ) : (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {fmtUsd(realizedToday || 0)} of {fmtUsd(dailyGoal || 0)} target · {openCount || 0} positions open ·{' '}
          {scanned || 0} coins scanned
        </p>
      )}
    </div>
  );
}