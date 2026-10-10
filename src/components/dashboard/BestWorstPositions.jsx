import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, TrendingDown, TrendingUp } from 'lucide-react';
import CoinAvatar from '@/components/common/CoinAvatar';
import { fmtPrice } from '@/lib/format';

function MoverRow({ position, best }) {
  const up = (position.pnl_usd || 0) >= 0;
  return (
    <Link
      to={`/coin/${position.symbol}`}
      className="flex items-center gap-3 rounded-xl border border-border/60 bg-secondary/20 px-3 py-2.5 transition-colors hover:bg-secondary/40"
    >
      <CoinAvatar symbol={position.symbol} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-heading text-sm font-semibold leading-tight">{position.symbol}</p>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${
              position.side === 'short'
                ? 'border-destructive/30 text-destructive'
                : 'border-primary/30 text-primary'
            }`}
          >
            {position.side}
          </span>
        </div>
        <p className="num mt-0.5 text-[11px] text-muted-foreground">
          {fmtPrice(position.entry_price)} → {fmtPrice(position.current_price)}
        </p>
      </div>
      <div className="text-right">
        <p className={`num text-sm font-semibold ${up ? 'text-primary' : 'text-destructive'}`}>
          {up ? '+' : ''}
          {(position.pnl_pct || 0).toFixed(2)}%
        </p>
        <p className={`num text-[11px] ${up ? 'text-primary' : 'text-destructive'}`}>
          {up ? '+' : ''}
          {(position.pnl_usd || 0).toFixed(2)} USD
        </p>
      </div>
      {best ? <TrendingUp className="h-4 w-4 shrink-0 text-primary" /> : <TrendingDown className="h-4 w-4 shrink-0 text-destructive" />}
    </Link>
  );
}

export default function BestWorstPositions({ positions }) {
  const rows = [...(positions || [])]
    .filter((p) => p && p.symbol)
    .sort((a, b) => (b.pnl_pct || 0) - (a.pnl_pct || 0));
  if (!rows.length) return null;
  const best = rows[0];
  const worst = rows[rows.length - 1];

  return (
    <div className="surface relative overflow-hidden p-4">
      <div className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-accent/10 blur-3xl" />
      <p className="relative text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        No qualifying setup right now — your open positions in focus
      </p>
      <div className="relative mt-3 space-y-2">
        <MoverRow position={best} best />
        {rows.length > 1 ? <MoverRow position={worst} /> : null}
      </div>
      <p className="relative mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <ArrowRight className="h-3 w-3" /> Tap a position to open its chart
      </p>
    </div>
  );
}