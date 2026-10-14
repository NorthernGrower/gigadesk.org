import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, ShoppingBag, Star } from 'lucide-react';
import CoinAvatar from '@/components/common/CoinAvatar';
import { EmptyState } from '@/components/common/States';
import { TIER_LABEL } from '@/lib/market';
import { fmtCompactUsd, fmtPct, fmtPrice } from '@/lib/format';

const COLUMNS = [
  { key: 'score', label: 'Score', align: 'left' },
  { key: 'price', label: 'Price', align: 'right' },
  { key: 'change24h', label: '24h', align: 'right' },
  { key: 'change7d', label: '7d', align: 'right' },
  { key: 'volume24h', label: 'Volume', align: 'right' },
  { key: 'required_move_pct', label: 'To target', align: 'right' },
];

function ScoreBar({ score, side }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-border/70">
        <div
          className={`h-full rounded-full ${side === 'short' ? 'bg-destructive' : 'bg-primary'}`}
          style={{ width: `${Math.max(3, Math.min(100, score))}%` }}
        />
      </div>
      <span className="num text-xs font-medium">{score}</span>
    </div>
  );
}

export default function ScreenerTable({ rows = [], onSelect, onWatch, onBuy, watchSymbols = [], targetPct = 2 }) {
  const [sortKey, setSortKey] = useState('score');
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = Number(a[sortKey]) || 0;
      const bv = Number(b[sortKey]) || 0;
      return asc ? av - bv : bv - av;
    });
    return copy;
  }, [rows, sortKey, asc]);

  const toggleSort = (key) => {
    if (key === sortKey) {
      setAsc(!asc);
      return;
    }
    setSortKey(key);
    setAsc(key === 'price');
  };

  if (!rows.length) {
    return (
      <EmptyState
        title="No setups matched those filters"
        description="Loosen the minimum score, switch tier, or rescan the market to pull fresh candle data."
      />
    );
  }

  return (
    <div className="surface overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border/70 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <th className="px-3 py-2.5 text-left font-medium">Coin</th>
              {COLUMNS.map((col) => (
                <th key={col.key} className={`px-3 py-2.5 font-medium ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${
                      sortKey === col.key ? 'text-foreground' : ''
                    }`}
                  >
                    {col.label}
                    {sortKey === col.key ? (
                      asc ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                    ) : (
                      <ChevronsUpDown className="h-3 w-3 opacity-40" />
                    )}
                  </button>
                </th>
              ))}
              <th className="px-3 py-2.5 text-right font-medium">Levels</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, index) => {
              const watched = watchSymbols.includes(row.symbol);
              const clears = row.required_move_pct >= targetPct;
              return (
                <tr
                  key={row.symbol}
                  onClick={() => onSelect(row)}
                  className="cursor-pointer border-b border-border/40 transition-colors last:border-b-0 hover:bg-secondary/40"
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="num w-5 text-right text-[10px] text-muted-foreground">{index + 1}</span>
                      <CoinAvatar symbol={row.symbol} />
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-display text-sm font-semibold">{row.symbol}</span>
                          <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                            {TIER_LABEL[row.market_cap_bucket] || '—'}
                          </span>
                        </div>
                        <span className="num text-[11px] text-muted-foreground">{fmtCompactUsd(row.volume24h)} traded</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="space-y-1">
                      <ScoreBar score={row.score} side={row.side} />
                      <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                        {row.verdict.replace('_', ' ')}
                      </span>
                    </div>
                  </td>
                  <td className="num px-3 py-2.5 text-right">{fmtPrice(row.price)}</td>
                  <td className={`num px-3 py-2.5 text-right ${row.change24h >= 0 ? 'text-primary' : 'text-destructive'}`}>
                    {fmtPct(row.change24h)}
                  </td>
                  <td className={`num px-3 py-2.5 text-right ${row.change7d >= 0 ? 'text-primary' : 'text-destructive'}`}>
                    {fmtPct(row.change7d)}
                  </td>
                  <td className="num px-3 py-2.5 text-right text-muted-foreground">{fmtCompactUsd(row.volume24h)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <span className={`num text-xs ${clears ? 'text-primary' : 'text-muted-foreground'}`}>
                      {fmtPct(row.required_move_pct, 1)}
                    </span>
                  </td>
                  <td className="num px-3 py-2.5 text-right text-[11px] text-muted-foreground">
                    <div className="flex items-center justify-end gap-2.5">
                      <span className="text-primary">{fmtPrice(row.target)}</span>
                      <span className="opacity-40">/</span>
                      <span className="text-destructive">{fmtPrice(row.stop)}</span>
                    </div>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {row.listed_on ? (
                        <button
                          type="button"
                          title={`Manual buy ${row.symbol}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onBuy(row);
                          }}
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
                        >
                          <ShoppingBag className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
                        onClick={(event) => {
                          event.stopPropagation();
                          onWatch(row);
                        }}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      >
                        <Star className={`h-3.5 w-3.5 ${watched ? 'fill-primary text-primary' : ''}`} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}