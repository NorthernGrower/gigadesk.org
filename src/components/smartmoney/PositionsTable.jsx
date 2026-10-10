import React from 'react';
import { Link } from 'react-router-dom';
import { fmtPrice, fmtUsd } from '@/lib/format';

export default function PositionsTable({ positions, traders }) {
  const nameFor = (wallet) => {
    const t = (traders || []).find((x) => x.wallet === wallet);
    if (t?.name) return t.name;
    return wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : '';
  };
  return (
    <div className="surface overflow-hidden">
      <div className="border-b border-border/60 px-4 py-3">
        <p className="font-heading text-sm font-semibold">Trades they're making</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Every open position the tracked traders hold right now
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <th className="px-4 py-2 font-medium">Coin</th>
              <th className="px-4 py-2 font-medium">Side</th>
              <th className="px-4 py-2 text-right font-medium">Size</th>
              <th className="px-4 py-2 text-right font-medium">Lev</th>
              <th className="px-4 py-2 text-right font-medium">Entry</th>
              <th className="px-4 py-2 text-right font-medium">Unrealised</th>
              <th className="px-4 py-2 text-right font-medium">Trader</th>
            </tr>
          </thead>
          <tbody>
            {(positions || []).map((p, i) => (
              <tr key={`${p.wallet}-${p.symbol}-${i}`} className="border-b border-border/40 last:border-0">
                <td className="px-4 py-2.5">
                  <Link to={`/coin/${p.symbol}`} className="font-heading font-semibold hover:text-primary">
                    {p.symbol}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${
                      p.side === 'short'
                        ? 'border-destructive/30 text-destructive'
                        : 'border-primary/30 text-primary'
                    }`}
                  >
                    {p.side}
                  </span>
                </td>
                <td className="num px-4 py-2.5 text-right">{fmtUsd(p.size_usd)}</td>
                <td className="num px-4 py-2.5 text-right text-muted-foreground">{p.leverage}x</td>
                <td className="num px-4 py-2.5 text-right">{fmtPrice(p.entry_price)}</td>
                <td className={`num px-4 py-2.5 text-right ${(p.unrealized_pnl_usd || 0) >= 0 ? 'text-primary' : 'text-destructive'}`}>
                  {fmtUsd(p.unrealized_pnl_usd)}
                </td>
                <td className="num px-4 py-2.5 text-right text-muted-foreground">#{p.trader_rank}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}