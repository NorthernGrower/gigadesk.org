import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import BiasTable from '@/components/smartmoney/BiasTable';
import PositionsTable from '@/components/smartmoney/PositionsTable';
import TraderTable from '@/components/smartmoney/TraderTable';
import { ErrorNotice, LoadingBlock } from '@/components/common/States';
import { fmtUsd } from '@/lib/format';

const WINDOWS = [
  { value: 'day', label: '24h' },
  { value: 'week', label: '7d' },
  { value: 'month', label: '30d' },
  { value: 'allTime', label: 'All time' },
];

export default function SmartMoneyPanel() {
  const [windowKey, setWindowKey] = useState('week');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    base44.functions
      .invoke('getSmartMoney', { window: windowKey })
      .then((res) => {
        if (alive) setData(res.data);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [windowKey]);

  const bias = data?.bias || [];
  const totalOpen = bias.reduce((a, b) => a + b.total_usd, 0);
  const netLong = [...bias].sort((a, b) => b.long_share_pct - a.long_share_pct)[0];
  const netShort = [...bias].sort((a, b) => a.long_share_pct - b.long_share_pct)[0];

  return (
    <div className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div>
          <p className="font-heading text-sm font-semibold">Smart money</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {(data?.traders?.length ?? 0)} top traders tracked · {fmtUsd(totalOpen)} open ·{' '}
            {netLong ? `${netLong.symbol} most long` : ''}
            {netShort && netShort.long_share_pct < 50 ? ` · ${netShort.symbol} most short` : ''} · feeds the bot's
            scoring
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-secondary/40 p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.value}
                type="button"
                onClick={() => setWindowKey(w.value)}
                className={`rounded-lg px-2.5 py-1 text-[11px] transition-colors ${
                  windowKey === w.value
                    ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => setWindowKey((k) => k)}
            className="rounded-lg border border-border/70 p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            aria-label="Refresh smart money"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="p-4">
          <ErrorNotice message={error} onRetry={() => setWindowKey((k) => k)} />
        </div>
      ) : loading && !data ? (
        <LoadingBlock label="Pulling the on-chain leaderboard and top traders' live books" />
      ) : (
        <div className="max-h-[440px] space-y-3 overflow-y-auto p-3">
          <BiasTable bias={bias.slice(0, 10)} />
          <TraderTable traders={data?.traders} />
          <PositionsTable positions={(data?.positions || []).slice(0, 40)} traders={data?.traders} />
        </div>
      )}
    </div>
  );
}