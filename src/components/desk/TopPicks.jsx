import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import BestBuyCard from '@/components/dashboard/BestBuyCard';
import CompactPick from '@/components/desk/CompactPick';
import BestWorstPositions from '@/components/dashboard/BestWorstPositions';

/**
 * The desk's top 3 picks: the best setup gets the spotlight card, picks 2 and 3
 * sit beside it. When a cycle produces no fresh board rows, the desk falls back
 * to the last stored setups so the top three always stay on the desk; with no
 * stored setups either, open positions stay in focus instead.
 */
export default function TopPicks({ rows = [], positions = [], targetPct = 2, onOpenChart, onAnalyze }) {
  const [stored, setStored] = useState(null);
  const fresh = (rows || []).slice(0, 3);
  const picks = fresh.length ? fresh : stored || [];

  useEffect(() => {
    if (fresh.length) return undefined;
    let alive = true;
    base44.entities.Signal
      .filter({ status: 'new' }, { sort: '-score', limit: 3 })
      .then((page) => {
        if (alive) setStored(page.items || []);
      })
      .catch(() => {
        if (alive) setStored([]);
      });
    return () => {
      alive = false;
    };
  }, [fresh.length]);

  if (!picks.length) return <BestWorstPositions positions={positions} />;

  return (
    <div className="space-y-3">
      <BestBuyCard
        row={picks[0]}
        targetPct={targetPct}
        onOpenChart={() => onOpenChart(picks[0].symbol)}
        onAnalyze={() => onAnalyze(picks[0].symbol)}
      />
      {picks.length > 1 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {picks.slice(1).map((row, i) => (
            <CompactPick
              key={`${row.symbol}|${row.side}`}
              row={row}
              rank={i + 2}
              onOpenChart={() => onOpenChart(row.symbol)}
              onAnalyze={() => onAnalyze(row.symbol)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}