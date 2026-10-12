import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import BestBuyCard from '@/components/dashboard/BestBuyCard';
import BestWorstPositions from '@/components/dashboard/BestWorstPositions';

/**
 * The desk's top ranked setup only. When a cycle produces no fresh board rows,
 * the desk falls back to the last stored setup so the top pick always stays on
 * the desk; with no stored setup either, open positions stay in focus instead.
 */
export default function TopPicks({ rows = [], positions = [], targetPct = 2, onOpenChart, onAnalyze }) {
  const [stored, setStored] = useState(null);
  const fresh = (rows || []).slice(0, 1);
  const pick = fresh.length ? fresh[0] : (stored || [])[0];

  useEffect(() => {
    if (fresh.length) return undefined;
    let alive = true;
    base44.entities.Signal
      .filter({ status: 'new' }, { sort: '-score', limit: 1 })
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

  if (!pick) return <BestWorstPositions positions={positions} />;

  return (
    <BestBuyCard
      row={pick}
      targetPct={targetPct}
      onOpenChart={() => onOpenChart(pick.symbol)}
      onAnalyze={() => onAnalyze(pick.symbol)}
    />
  );
}