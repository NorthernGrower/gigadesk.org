import React, { useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { base44 } from '@/api/base44Client';
import { fmtPct, fmtUsd } from '@/lib/format';

function Stat({ label, value, tone = 'neutral', hint }) {
  const tones = { up: 'text-primary', down: 'text-destructive', neutral: 'text-foreground' };
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`num mt-1 text-base font-semibold ${tones[tone]}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default function EquityPanel({ startingBalance = 10000, dailyTargetPct = 2 }) {
  const [state, setState] = useState({ loading: true, points: [], stats: null, error: null });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [profit, loss, daily] = await Promise.all([
          base44.entities.Trade.aggregate({ query: { status: 'closed', pnl_usd: { $gt: 0 } }, sum: ['pnl_usd'] }),
          base44.entities.Trade.aggregate({ query: { status: 'closed', pnl_usd: { $lt: 0 } }, sum: ['pnl_usd'] }),
          base44.entities.Trade.aggregate({
            query: { status: 'closed' },
            dateBucket: { field: 'closed_at', unit: 'day' },
            sum: ['pnl_usd'],
          }),
        ]);
        if (cancelled) return;

        const grossProfit = Number(profit?.rows?.[0]?.sum_pnl_usd) || 0;
        const grossLoss = Number(loss?.rows?.[0]?.sum_pnl_usd) || 0;
        const wins = Number(profit?.rows?.[0]?.count) || 0;
        const losses = Number(loss?.rows?.[0]?.count) || 0;
        const net = grossProfit + grossLoss;
        const trades = wins + losses;

        const buckets = [...(daily?.rows || [])].sort((a, b) =>
          String(a.closed_at).localeCompare(String(b.closed_at)),
        );
        let running = Number(startingBalance) || 0;
        const points = buckets.map((b) => {
          running += Number(b.sum_pnl_usd) || 0;
          return { day: b.closed_at, equity: Math.round(running * 100) / 100, pnl: Number(b.sum_pnl_usd) || 0 };
        });

        setState({
          loading: false,
          error: null,
          points,
          stats: {
            net,
            trades,
            wins,
            losses,
            winRate: trades ? (wins / trades) * 100 : 0,
            grossProfit,
            grossLoss,
            profitFactor: grossLoss ? grossProfit / Math.abs(grossLoss) : null,
            avgWin: wins ? grossProfit / wins : 0,
            avgLoss: losses ? grossLoss / losses : 0,
          },
        });
      } catch (error) {
        if (!cancelled) setState({ loading: false, points: [], stats: null, error: error.message });
      }
    };

    load();
    window.addEventListener('bot:tick', load);
    return () => {
      cancelled = true;
      window.removeEventListener('bot:tick', load);
    };
  }, [startingBalance]);

  const { stats, points, loading, error } = state;
  const net = stats?.net || 0;

  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Paper equity</p>
        <span className="num text-[11px] text-muted-foreground">
          target {fmtPct(dailyTargetPct)} / day
        </span>
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">Adding up your closed trades…</p>
      ) : error ? (
        <p className="mt-4 text-sm text-destructive">{error}</p>
      ) : points.length === 0 ? (
        <div className="mt-4 space-y-1">
          <p className="num text-3xl font-semibold">{fmtUsd(startingBalance)}</p>
          <p className="text-sm text-muted-foreground">
            No closed trades yet — the curve builds as the bot takes profit or stops out.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-end justify-between">
            <div>
              <p className={`num text-3xl font-semibold ${net >= 0 ? 'text-primary' : 'text-destructive'}`}>
                {fmtUsd(points[points.length - 1].equity)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                from {fmtUsd(startingBalance)} · realised {fmtUsd(net)}
              </p>
            </div>
            <span className={`num text-sm ${net >= 0 ? 'text-primary' : 'text-destructive'}`}>{fmtPct((net / (startingBalance || 1)) * 100)}</span>
          </div>

          <div className="mt-3 h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
                <defs>
                  <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.3} vertical={false} />
                <XAxis dataKey="day" hide />
                <YAxis
                  orientation="right"
                  domain={['auto', 'auto']}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={62}
                  tickFormatter={(v) => `$${Math.round(Number(v) / 100) / 10}k`}
                />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 12,
                    fontSize: 11,
                  }}
                  formatter={(value) => [fmtUsd(value), 'Equity']}
                />
                <Area
                  type="monotone"
                  dataKey="equity"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="url(#equityFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-4 border-t border-border/60 pt-3 sm:grid-cols-4">
            <Stat label="Trades closed" value={stats.trades} hint={`${stats.wins}W · ${stats.losses}L`} />
            <Stat label="Win rate" value={`${stats.winRate.toFixed(0)}%`} tone={stats.winRate >= 50 ? 'up' : 'neutral'} />
            <Stat label="Avg win" value={fmtUsd(stats.avgWin)} tone="up" />
            <Stat
              label="Profit factor"
              value={stats.profitFactor ? stats.profitFactor.toFixed(2) : '—'}
              tone={stats.profitFactor && stats.profitFactor > 1 ? 'up' : 'down'}
              hint="gross win ÷ gross loss"
            />
          </div>
        </>
      )}
    </div>
  );
}