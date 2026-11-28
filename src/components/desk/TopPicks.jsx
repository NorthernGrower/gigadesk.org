import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import BestBuyCard from '@/components/dashboard/BestBuyCard';
import BestWorstPositions from '@/components/dashboard/BestWorstPositions';

/**
 * The desk's top ranked setup only. When a cycle produces no fresh board rows,
 * the desk falls back to the last stored setup so the top pick always stays on
 * the desk; with no stored setup either, open positions stay in focus instead.
 */
export default function TopPicks({ rows = [], positions = [], targetPct = 2, onOpenChart, onAnalyze, allowStored = true }) {
  const [stored, setStored] = useState(null);
  const fresh = (rows || []).slice(0, 1);
  const pick = fresh.length ? fresh[0] : allowStored ? (stored || [])[0] : null;

  useEffect(() => {
    // the stored fallback is a dollar-priced Signal row: on the Bitcoin book it
    // would put a dollar setup on a BTC desk, so that book never falls back
    if (fresh.length || !allowStored) return undefined;
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
  }, [fresh.length, allowStored]);

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