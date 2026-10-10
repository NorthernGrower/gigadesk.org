import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import BiasTable from '@/components/smartmoney/BiasTable';
import PositionsTable from '@/components/smartmoney/PositionsTable';
import TraderTable from '@/components/smartmoney/TraderTable';
import StatCard from '@/components/common/StatCard';
import { ErrorNotice, LoadingBlock } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { fmtUsd } from '@/lib/format';

const WINDOWS = [
  { value: 'day', label: '24h' },
  { value: 'week', label: '7d' },
  { value: 'month', label: '30d' },
  { value: 'allTime', label: 'All time' },
];

export default function SmartMoney() {
  const [windowKey, setWindowKey] = useState('week');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async (win) => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('getSmartMoney', { window: win });
      setData(res.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(windowKey);
  }, [windowKey]);

  const bias = data?.bias || [];
  const totalOpen = bias.reduce((a, b) => a + b.total_usd, 0);
  const netLong = [...bias].sort((a, b) => b.long_share_pct - a.long_share_pct)[0];
  const netShort = [...bias].sort((a, b) => a.long_share_pct - b.long_share_pct)[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold">Smart money</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Who the best traders are, what they're trading, and how their positions feed the bot's picks
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-secondary/40 p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.value}
                type="button"
                onClick={() => setWindowKey(w.value)}
                className={`rounded-lg px-3 py-1.5 text-[11px] transition-colors ${
                  windowKey === w.value
                    ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => load(windowKey)}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {error ? <ErrorNotice message={error} onRetry={() => load(windowKey)} /> : null}

      {loading && !data ? (
        <LoadingBlock label="Pulling the on-chain leaderboard and top traders' live books" />
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Traders tracked" value={data.traders?.length ?? 0} sub={`best ${windowKey} results`} />
            <StatCard label="Open size tracked" value={fmtUsd(totalOpen)} sub="their combined open positions" />
            <StatCard
              label="Most net long"
              value={netLong ? netLong.symbol : '—'}
              sub={netLong ? `${netLong.long_share_pct}% long of ${fmtUsd(netLong.total_usd)}` : ''}
              tone="up"
            />
            <StatCard
              label="Most net short"
              value={netShort && netShort.long_share_pct < 50 ? netShort.symbol : '—'}
              sub={
                netShort && netShort.long_share_pct < 50
                  ? `${100 - netShort.long_share_pct}% short of ${fmtUsd(netShort.total_usd)}`
                  : ''
              }
              tone="down"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="space-y-4">
              <TraderTable traders={data.traders} />
              <PositionsTable positions={data.positions} traders={data.traders} />
            </div>
            <BiasTable bias={bias.slice(0, 20)} />
          </div>

          <p className="text-[11px] text-muted-foreground">
            Updated {data.fetched_at ? new Date(data.fetched_at).toLocaleString() : '—'}. These biases add up to ±5
            points on the bot's setup score; technicals still dominate.
          </p>
        </>
      ) : null}
    </div>
  );
}