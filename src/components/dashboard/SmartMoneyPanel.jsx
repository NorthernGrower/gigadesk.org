import React, { useEffect, useRef, useState } from 'react';
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
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // the board the app saved last, shown while a feed cannot be read
  const [note, setNote] = useState(null);

  // the refresh button and Try again both re-read: a new attempt is what the
  // effect below watches, where setting the same window again changed nothing
  const forceRef = useRef(false);
  const reload = () => {
    forceRef.current = true;
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    let alive = true;
    // a plain load takes the board the desk saved when it is only minutes old;
    // the button asks the feeds for a fresh one
    const force = forceRef.current;
    forceRef.current = false;
    setLoading(true);
    setError(null);
    base44.functions
      .invoke('getSmartMoney', { window: windowKey, force })
      .then((res) => {
        if (!alive) return;
        const payload = res?.data || {};
        const traders = payload.traders || [];
        // a refresh that failed says why: with a saved board the panel shows
        // that board and the reason above it, without one it shows the reason
        if (payload.error && !traders.length) {
          setNote(null);
          setData(null);
          setError(payload.error);
          return;
        }
        setError(null);
        setNote(payload.error || null);
        setData(payload);
      })
      .catch((err) => {
        if (!alive) return;
        setNote(null);
        setData(null);
        setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [windowKey, attempt]);

  const traders = data?.traders || [];
  const bias = data?.bias || [];
  const totalOpen = bias.reduce((a, b) => a + (Number(b.total_usd) || 0), 0);
  const netLong = [...bias].sort((a, b) => b.long_share_pct - a.long_share_pct)[0];
  const netShort = [...bias].sort((a, b) => a.long_share_pct - b.long_share_pct)[0];

  return (
    <div className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div>
          <p className="font-heading text-sm font-semibold">Smart money</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {data
              ? `${traders.length} top traders tracked · ${fmtUsd(totalOpen)} open${
                  netLong ? ` · ${netLong.symbol} most long` : ''
                }${netShort && netShort.long_share_pct < 50 ? ` · ${netShort.symbol} most short` : ''} · feeds the bot's scoring`
              : 'The on-chain leaderboard and the top traders’ live books'}
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
            onClick={reload}
            className="rounded-lg border border-border/70 p-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            aria-label="Refresh smart money"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="p-4">
          <ErrorNotice message={error} onRetry={reload} />
        </div>
      ) : loading && !data ? (
        <LoadingBlock label="Pulling the on-chain leaderboard and top traders' live books" />
      ) : (
        <div className="max-h-[440px] space-y-3 overflow-y-auto p-3">
          {note ? (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] leading-snug text-amber-300">
              Showing the last board the desk saved. {note}
            </div>
          ) : null}
          <BiasTable bias={bias.slice(0, 10)} />
          <TraderTable traders={traders} />
          <PositionsTable positions={(data?.positions || []).slice(0, 40)} traders={traders} />
        </div>
      )}
    </div>
  );
}
