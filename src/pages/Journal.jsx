import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import PerformancePanel from '@/components/journal/PerformancePanel';
import TradeForm from '@/components/journal/TradeForm';
import TradeTable from '@/components/journal/TradeTable';
import { ErrorNotice, LoadingBlock } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { onTradesChange } from '@/lib/live';
import { ensureBotConfig } from '@/lib/market';

export default function Journal() {
  const [mode, setMode] = useState('all');
  const [status, setStatus] = useState('all');
  const [trades, setTrades] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [base, setBase] = useState(10000);

  const load = async (options = {}) => {
    const nextMode = options.mode ?? mode;
    const nextStatus = options.status ?? status;
    const reset = options.reset !== false;
    if (reset) setLoading(true);
    else setLoadingMore(true);
    setError(null);

    const query = {};
    if (nextMode !== 'all') query.mode = nextMode;
    if (nextStatus !== 'all') query.status = nextStatus;

    try {
      const page = await base44.entities.Trade.filter(query, {
        sort: '-created_date',
        limit: 50,
        ...(reset ? {} : { cursor }),
      });
      const items = Array.isArray(page) ? page : page.items || [];
      setTrades((prev) => (reset ? items : [...prev, ...items]));
      setCursor(page.next_cursor || null);
      setHasMore(Boolean(page.has_more));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const config = await ensureBotConfig();
        if (alive) setBase(Number(config.starting_balance) || 10000);
      } catch {
        // the performance panel falls back to the default base
      }
    })();
    load({ reset: true });
    return () => {
      alive = false;
    };
  }, []);

  const loadRef = React.useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => onTradesChange(() => loadRef.current({ reset: true })), []);

  return (
    <div className="space-y-4">
      <PerformancePanel base={base} />

      {error ? <ErrorNotice message={error} onRetry={() => load({ reset: true })} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <Select
              value={mode}
              onValueChange={(value) => {
                setMode(value);
                load({ mode: value, reset: true });
              }}
            >
              <SelectTrigger className="h-9 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All trades</SelectItem>
                <SelectItem value="paper">Paper bot</SelectItem>
                <SelectItem value="real">Real money</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                load({ status: value, reset: true });
              }}
            >
              <SelectTrigger className="h-9 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any status</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="proposed">Awaiting approval</SelectItem>
              </SelectContent>
            </Select>
            <span className="num text-[11px] text-muted-foreground">{trades.length} shown</span>
          </div>

          {loading ? (
            <LoadingBlock label="Loading your trade journal" />
          ) : (
            <>
              <TradeTable trades={trades} onChanged={() => load({ reset: true })} />
              {hasMore ? (
                <Button variant="outline" className="w-full" onClick={() => load({ reset: false })} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load older trades'}
                </Button>
              ) : null}
            </>
          )}
        </div>

        <div className="space-y-4">
          <TradeForm onSaved={() => load({ reset: true })} />
        </div>
      </div>
    </div>
  );
}