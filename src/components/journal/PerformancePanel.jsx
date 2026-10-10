import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { fmtPct, fmtUsd } from '@/lib/format';
import { onTradesChange } from '@/lib/live';

function Metric({ label, value, tone = 'neutral', hint }) {
  const tones = { up: 'text-primary', down: 'text-destructive', neutral: 'text-foreground' };
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`num mt-1 text-base font-semibold ${tones[tone]}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Block({ title, hint, data, loading }) {
  if (loading) {
    return (
      <div className="surface p-4">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
        <p className="mt-3 text-sm text-muted-foreground">Adding things up…</p>
      </div>
    );
  }
  const decided = data.trades - (data.zeros || 0);
  const winRate = decided ? (data.wins / decided) * 100 : 0;
  return (
    <div className="surface space-y-3 p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
        <p className={`num text-lg font-semibold ${data.net >= 0 ? 'text-primary' : 'text-destructive'}`}>
          {fmtUsd(data.net)}
        </p>
      </div>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
      <div className="grid grid-cols-3 gap-3 border-t border-border/60 pt-3">
        <Metric label="Closed" value={data.trades} />
        <Metric
          label="Win rate"
          value={`${winRate.toFixed(0)}%`}
          tone={winRate >= 50 ? 'up' : 'neutral'}
          hint={data.zeros ? `${data.zeros} break-even excluded` : undefined}
        />
        <Metric
          label="Avg per trade"
          value={fmtUsd(data.trades ? data.net / data.trades : 0)}
          tone={data.net >= 0 ? 'up' : 'down'}
        />
      </div>
      <p className="num text-[11px] text-muted-foreground">
        {data.trades ? `${fmtPct((data.net / (data.base || 10000)) * 100)} on a ${fmtUsd(data.base || 10000)} base` : 'No closed trades yet'}
      </p>
    </div>
  );
}

export default function PerformancePanel({ base = 10000 }) {
  const [state, setState] = useState({
    loading: true,
    paper: { net: 0, trades: 0, wins: 0, base },
    real: { net: 0, trades: 0, wins: 0, base },
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [paperAgg, realAgg, paperWins, realWins, paperZeros, realZeros] = await Promise.all([
        base44.entities.Trade.aggregate({ query: { status: 'closed', mode: 'paper' }, sum: ['pnl_usd'] }),
        base44.entities.Trade.aggregate({ query: { status: 'closed', mode: 'real' }, sum: ['pnl_usd'] }),
        base44.entities.Trade.count({ status: 'closed', mode: 'paper', pnl_usd: { $gt: 0 } }),
        base44.entities.Trade.count({ status: 'closed', mode: 'real', pnl_usd: { $gt: 0 } }),
        base44.entities.Trade.count({ status: 'closed', mode: 'paper', pnl_usd: 0 }),
        base44.entities.Trade.count({ status: 'closed', mode: 'real', pnl_usd: 0 }),
      ]);
      if (cancelled) return;
      const read = (agg, wins, zeros) => ({
        net: Number(agg?.rows?.[0]?.sum_pnl_usd) || 0,
        trades: Number(agg?.rows?.[0]?.count) || 0,
        wins: Number(wins) || 0,
        zeros: Number(zeros) || 0,
        base,
      });
      setState({
        loading: false,
        paper: read(paperAgg, paperWins, paperZeros),
        real: read(realAgg, realWins, realZeros),
      });
    };
    load();
    window.addEventListener('bot:tick', load);
    const stopLive = onTradesChange(load);
    return () => {
      cancelled = true;
      window.removeEventListener('bot:tick', load);
      stopLive();
    };
  }, [base]);

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Block
        title="Paper bot"
        hint="Every simulated trade the bot opened and closed."
        data={state.paper}
        loading={state.loading}
      />
      <Block
        title="Real money log"
        hint="The fills you logged from your own exchange — tracked separately from the paper balance."
        data={state.real}
        loading={state.loading}
      />
    </div>
  );
}