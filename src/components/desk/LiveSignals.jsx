import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, Radar } from 'lucide-react';

const px = (v) => {
  const n = Number(v) || 0;
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n ? n.toPrecision(4) : '—';
};

const scoreTone = (score) =>
  score >= 80
    ? 'bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/30'
    : score >= 70
      ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
      : 'bg-secondary text-muted-foreground ring-1 ring-border';

export default function LiveSignals({ rows, exchange }) {
  const setups = (rows || []).slice(0, 1);
  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Top-ranked signals</p>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Radar className="h-3.5 w-3.5" />
          {exchange ? `pairs on ${exchange}` : 'shared universe'}
        </span>
      </div>

      {!setups.length ? (
        <p className="mt-3 text-[12px] text-muted-foreground">
          No qualifying setups in the last scan — the engine ranks every eligible market each cycle.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {setups.map((row) => (
            <Link
              key={`${row.symbol}-${row.side}`}
              to={`/coin/${row.symbol}`}
              className="flex items-start gap-3 rounded-xl border border-border/50 bg-secondary/20 p-3 transition-colors hover:border-primary/40"
            >
              {row.side === 'short' ? (
                <ArrowDownRight className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              ) : (
                <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{row.symbol}</span>
                  <span className="num text-[11px] text-muted-foreground">{row.pair || `${row.symbol}/USDT`}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${scoreTone(row.score)}`}>
                    {row.score}
                  </span>
                  {row.confidence != null ? (
                    <span className="text-[11px] text-muted-foreground">confidence {row.confidence}%</span>
                  ) : null}
                  {row.fib_phase ? (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                      fib {row.fib_phase}
                    </span>
                  ) : null}
                  {row.elliott ? (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                      elliott {row.elliott.replace('_', ' ')}
                    </span>
                  ) : null}
                </div>
                <div className="num mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>entry {px(row.entry)}</span>
                  <span>target {px(row.target)}</span>
                  <span>stop {px(row.stop)}</span>
                  <span>RR {row.risk_reward}:1</span>
                </div>
                {(row.reasons || []).length ? (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                    {row.reasons.slice(0, 2).join(' · ')}
                  </p>
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}