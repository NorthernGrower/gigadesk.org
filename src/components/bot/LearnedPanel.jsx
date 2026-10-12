import React, { useEffect, useState } from 'react';
import { BrainCircuit } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { onTradesChange } from '@/lib/live';

const CAP_LABELS = {
  large: 'large caps',
  mid: 'mid caps',
  small: 'small caps',
  micro: 'micro caps',
  unknown: 'unknown caps',
};

function scoreAdj(row) {
  const trades = row.count || 0;
  const winRate = Number(row.avg_win) || 0;
  if (trades < 5) return 0;
  if (winRate >= 0.65) return Math.min(8, Math.round((winRate - 0.5) * 20));
  if (winRate <= 0.35) return -Math.min(8, Math.round((0.5 - winRate) * 20));
  return 0;
}

export default function LearnedPanel() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const agg = await base44.entities.Lesson.aggregate({
          groupBy: 'pattern',
          avg: ['win', 'pnl_pct'],
          sort: '-count',
          limit: 20,
        });
        if (alive) setRows((agg.rows || []).filter((r) => r.pattern));
      } catch (err) {
        if (alive) setRows([]);
      }
    };
    load();
    const stopLive = onTradesChange(load);
    return () => {
      alive = false;
      stopLive();
    };
  }, []);

  return (
    <div className="surface p-4">
      <div className="flex items-center gap-2">
        <BrainCircuit className="h-4 w-4 text-primary" />
        <p className="font-heading text-sm font-medium">What the bot learned</p>
      </div>

      {rows === null ? (
        <p className="mt-3 text-sm text-muted-foreground">Reviewing closed calls…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No lessons yet. Every closed bot call is remembered by its pattern (side and cap tier), and once a pattern has
          at least 5 closed trades its win rate starts shaping future scores.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {rows.map((row) => {
            const [side, bucket] = String(row.pattern).split('/');
            const trades = row.count || 0;
            const winRate = Math.round((Number(row.avg_win) || 0) * 100);
            const avgPnl = Math.round((Number(row.avg_pnl_pct) || 0) * 100) / 100;
            const adj = scoreAdj(row);
            return (
              <div
                key={row.pattern}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium capitalize">
                    {side} · {CAP_LABELS[bucket] || bucket}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {trades} trade{trades === 1 ? '' : 's'} · {winRate}% win · avg {avgPnl > 0 ? '+' : ''}
                    {avgPnl}%
                  </p>
                </div>
                <span
                  className={`num shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${
                    adj > 0
                      ? 'bg-primary/10 text-primary'
                      : adj < 0
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {adj > 0 ? `+${adj}` : adj || '±0'} score
                </span>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
        Winning patterns earn up to +8 on future scores, losing ones up to −8.
      </p>
    </div>
  );
}