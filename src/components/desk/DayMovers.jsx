import React from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import CoinAvatar from '@/components/common/CoinAvatar';
import { fmtPrice, fmtUsd } from '@/lib/format';

function MoverCard({ trade, best }) {
  if (!trade) return null;
  const up = (trade.pnl_usd || 0) >= 0;
  const Icon = best ? TrendingUp : TrendingDown;
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          <Icon className={`h-3.5 w-3.5 ${best ? 'text-primary' : 'text-destructive'}`} />
          {best ? 'Top trade today' : 'Top loser today'}
        </p>
        {trade.exit_reason ? (
          <span className="rounded-full bg-border/40 px-2 py-0.5 text-[10px] text-muted-foreground">
            {String(trade.exit_reason).replace('_', ' ')}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-2.5">
        <CoinAvatar symbol={trade.symbol} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="font-display text-sm font-semibold">{trade.symbol}</p>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase ${
                trade.side === 'short' ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
              }`}
            >
              {trade.side}
            </span>
          </div>
          <p className="num mt-0.5 text-[11px] text-muted-foreground">
            {trade.exchange ? `${trade.exchange} · ` : ''}closed today
          </p>
        </div>
        <div className="text-right">
          <p className={`num text-sm font-semibold ${up ? 'text-primary' : 'text-destructive'}`}>
            {fmtUsd(trade.pnl_usd)}
          </p>
          <p className={`num text-[11px] ${up ? 'text-primary' : 'text-destructive'}`}>
            {fmtPrice(trade.pnl_pct)}%
          </p>
        </div>
      </div>
    </div>
  );
}

export default function DayMovers({ best, worst }) {
  if (!best && !worst) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <MoverCard trade={best} best />
      <MoverCard trade={worst} />
    </div>
  );
}