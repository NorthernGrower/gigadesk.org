import React from 'react';
import { Link } from 'react-router-dom';
import { fmtUsd } from '@/lib/format';

export default function BiasTable({ bias }) {
  return (
    <div className="surface overflow-hidden">
      <div className="border-b border-border/60 px-4 py-3">
        <p className="font-heading text-sm font-semibold">Where the smart money is</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Open size across the tracked traders, per coin
        </p>
      </div>
      <div className="divide-y divide-border/40">
        {(bias || []).map((b) => (
          <Link
            key={b.symbol}
            to={`/coin/${b.symbol}`}
            className="block px-4 py-2.5 transition-colors hover:bg-secondary/30"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <p className="font-heading text-sm font-semibold">{b.symbol}</p>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${
                    b.dir === 'long'
                      ? 'border-primary/30 text-primary'
                      : 'border-destructive/30 text-destructive'
                  }`}
                >
                  net {b.dir}
                </span>
                <span className="num text-[11px] text-muted-foreground">{b.traders} traders</span>
              </div>
              <div className="text-right">
                <p className="num text-sm">{fmtUsd(b.total_usd)}</p>
                <p className="num text-[11px] text-muted-foreground">
                  {b.longs}L / {b.shorts}S
                </p>
              </div>
            </div>
            <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-destructive/30">
              <div className="bg-primary" style={{ width: `${b.long_share_pct}%` }} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}