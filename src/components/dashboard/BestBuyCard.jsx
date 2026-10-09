import React from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import CoinAvatar from '@/components/common/CoinAvatar';
import ScoreBadge from '@/components/common/ScoreBadge';
import { TIER_LABEL } from '@/lib/market';
import { fmtPct, fmtPrice } from '@/lib/format';

function Ring({ score, side }) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;
  const color = side === 'short' ? 'hsl(var(--destructive))' : 'hsl(var(--primary))';
  return (
    <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      <svg viewBox="0 0 64 64" className="absolute inset-0 h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={radius} fill="none" stroke="hsl(var(--border))" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
        />
      </svg>
      <span className="num text-lg font-semibold">{score}</span>
    </div>
  );
}

function Level({ label, value, tone }) {
  const tones = { target: 'text-primary', stop: 'text-destructive' };
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`num mt-0.5 text-sm ${tones[tone] || ''}`}>{value}</p>
    </div>
  );
}

export default function BestBuyCard({ row, targetPct = 2, onOpenChart, onAnalyze }) {
  if (!row) return null;
  const clears = row.required_move_pct >= targetPct;

  return (
    <div className="surface relative overflow-hidden p-4">
      <div className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Top ranked setup right now
          </p>
          <div className="mt-2 flex items-center gap-3">
            <CoinAvatar symbol={row.symbol} size="lg" />
            <div className="min-w-0">
              <p className="font-heading text-lg font-semibold leading-tight">{row.symbol}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="num text-sm text-muted-foreground">{fmtPrice(row.price)}</span>
                <span className={`num text-xs ${row.change24h >= 0 ? 'text-primary' : 'text-destructive'}`}>
                  {fmtPct(row.change24h)}
                </span>
                <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {TIER_LABEL[row.market_cap_bucket] || 'Tier'}
                </span>
              </div>
            </div>
          </div>
        </div>
        <Ring score={row.score} side={row.side} />
      </div>

      <div className="relative mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Level label="Entry" value={fmtPrice(row.entry)} />
        <Level label="Target" value={fmtPrice(row.target)} tone="target" />
        <Level label="Stop" value={fmtPrice(row.stop)} tone="stop" />
        <Level label="Risk / reward" value={`${row.risk_reward}:1`} />
      </div>

      <div className="relative mt-3 flex flex-wrap items-center gap-2">
        <ScoreBadge verdict={row.verdict} score={row.score} />
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
            clears
              ? 'border-primary/30 bg-primary/10 text-primary'
              : 'border-border bg-secondary/40 text-muted-foreground'
          }`}
        >
          needs {fmtPct(row.required_move_pct, 1)} to target {clears ? `· clears your ${targetPct}% bar` : `· under your ${targetPct}% bar`}
        </span>
        <span className="num text-[11px] text-muted-foreground">confidence {row.confidence}%</span>
      </div>

      {row.reasons?.length ? (
        <ul className="relative mt-3 space-y-1">
          {row.reasons.slice(0, 3).map((reason) => (
            <li key={reason} className="flex items-start gap-2 text-xs text-muted-foreground">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
              {reason}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="relative mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={onOpenChart}>
          Open the chart <ArrowRight className="ml-2 h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="outline" onClick={onAnalyze}>
          <Sparkles className="mr-2 h-3.5 w-3.5" /> Analyse with AI
        </Button>
      </div>
    </div>
  );
}