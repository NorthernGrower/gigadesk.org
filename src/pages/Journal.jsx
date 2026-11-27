import React, { useEffect, useRef, useState } from 'react';
import { addMonths, startOfMonth } from 'date-fns';
import { base44 } from '@/api/base44Client';
import PerformancePanel from '@/components/journal/PerformancePanel';
import TradeCalendar from '@/components/journal/TradeCalendar';
import TradeForm from '@/components/journal/TradeForm';
import { ErrorNotice } from '@/components/common/States';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { onTradesChange } from '@/lib/live';
import { ensureBotConfig } from '@/lib/market';

export default function Journal() {
  const [desk, setDesk] = useState(null);
  const [status, setStatus] = useState('all');
  const [result, setResult] = useState('all');
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [base, setBase] = useState(10000);

  const mode = desk === 'live' ? 'real' : 'paper';

  // the calendar reads one month at a time — the day markers and the trades
  // behind a day, never a long list of everything the bot ever opened
  const load = async (options = {}) => {
    const nextMonth = options.month || month;
    setLoading(true);
    setError(null);

    const query = { mode };
    if (status !== 'all') query.status = status;
    if (result === 'win') query.pnl_usd = { $gt: 0 };
    else if (result === 'loss') query.pnl_usd = { $lt: 0 };
    else if (result === 'flat') query.pnl_usd = 0;

    try {
      const start = startOfMonth(nextMonth);
      const end = addMonths(start, 1);
      const page = await base44.entities.Trade.filter(
        { ...query, created_date: { $gte: start.toISOString(), $lt: end.toISOString() } },
        { sort: '-created_date', limit: 500 },
      );
      setTrades(Array.isArray(page) ? page : page?.items || []);
    } catch (err) {
      setError(err.message);
      setTrades([]);
    } finally {
      setLoading(false);
    }
  };

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  // the journal follows the active desk: live shows real money fills, paper
  // shows the bot's simulated trades
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const config = await ensureBotConfig();
        if (alive) {
          setBase(Number(config.starting_balance) || 10000);
          setDesk(config.active_desk === 'live' ? 'live' : 'paper');
        }
      } catch {
        if (alive) setDesk('paper');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onDeskChange = (event) => {
      if (event.detail === 'live' || event.detail === 'paper') setDesk(event.detail);
    };
    window.addEventListener('desk:changed', onDeskChange);
    return () => window.removeEventListener('desk:changed', onDeskChange);
  }, []);

  // a desk change, a new month or a filter re-reads the calendar
  useEffect(() => {
    if (!desk) return;
    loadRef.current({});
  }, [desk, month, status, result]);

  // the cycle closes trades while this page is open: re-read the month
  useEffect(() => onTradesChange(() => loadRef.current({})), []);

  return (
    <div className="space-y-4">
      <PerformancePanel base={base} desk={desk} />

      {error ? <ErrorNotice message={error} onRetry={() => loadRef.current({})} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              className={`rounded-lg border px-3 py-2 text-[11px] font-medium ${
                mode === 'real'
                  ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                  : 'border-border/70 bg-secondary/40 text-muted-foreground'
              }`}
            >
              {mode === 'real' ? 'Live desk journal' : 'Paper desk journal'}
            </span>
            <Select value={status} onValueChange={setStatus}>
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
            <Select value={result} onValueChange={setResult}>
              <SelectTrigger className="h-9 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any result</SelectItem>
                <SelectItem value="win">Winners</SelectItem>
                <SelectItem value="loss">Losers</SelectItem>
                <SelectItem value="flat">Break-even</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <TradeCalendar
            trades={trades}
            month={month}
            onMonthChange={(next) => setMonth(startOfMonth(next))}
            loading={loading}
            onChanged={() => loadRef.current({})}
          />
        </div>

        <div className="space-y-4">
          <TradeForm onSaved={() => loadRef.current({})} />
        </div>
      </div>
    </div>
  );
}
