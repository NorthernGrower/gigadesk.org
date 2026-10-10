import React, { useEffect, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Customized,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format, parseISO } from 'date-fns';
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

function EquityTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-[11px] shadow-lg">
      <p className="font-heading font-medium">{p.label}</p>
      <p className="num mt-1 text-muted-foreground">
        O {fmtUsd(p.open)} · C {fmtUsd(p.close)}
      </p>
      <p className="num text-muted-foreground">
        H {fmtUsd(p.high)} · L {fmtUsd(p.low)}
      </p>
      {p.live ? <p className="mt-1 text-accent">Live position, marked to market</p> : null}
    </div>
  );
}

// Draws one candle per day over the line's own axis scales
function renderCandles(points) {
  return function CandleLayer(props) {
    const items = props.formattedGraphicalItems || [];
    const line = items.find((it) => it?.props?.points?.length);
    let xOf = null;
    let yScale = null;
    let bw = 16;

    if (line) {
      const pts = line.props.points;
      xOf = (i) => pts[i]?.x;
      yScale = line.yAxis?.scale || null;
      const step = pts.length > 1 ? Math.abs(pts[1].x - pts[0].x) : 28;
      bw = Math.min(16, Math.max(6, step * 0.55));
    }
    if (!xOf || !yScale) {
      const xMap = props.xAxisMap ? Object.values(props.xAxisMap)[0] : null;
      const yMap = props.yAxisMap ? Object.values(props.yAxisMap)[0] : null;
      if (!xMap?.scale || !yMap?.scale) return null;
      const xs = xMap.scale;
      const band = xs.bandwidth ? xs.bandwidth() : 28;
      bw = Math.min(16, Math.max(6, band * 0.55));
      xOf = (i) => {
        const x = xs(points[i]?.label);
        return x == null ? null : x + band / 2;
      };
      yScale = yMap.scale;
    }

    return (
      <g>
        {points.map((p, i) => {
          const cx = xOf(i);
          if (cx == null) return null;
          const up = p.close >= p.open;
          const color = up ? 'hsl(var(--primary))' : 'hsl(var(--destructive))';
          const yTop = yScale(Math.max(p.open, p.close));
          const yBot = yScale(Math.min(p.open, p.close));
          return (
            <g key={p.day}>
              <line
                x1={cx}
                x2={cx}
                y1={yScale(p.high)}
                y2={yScale(p.low)}
                stroke={color}
                strokeWidth={1.5}
                opacity={0.9}
              />
              <rect
                x={cx - bw / 2}
                y={yTop}
                width={bw}
                height={Math.max(2, yBot - yTop)}
                rx={2}
                fill={color}
                opacity={p.live ? 0.5 : 0.9}
              />
              {p.live ? (
                <>
                  <circle cx={cx} cy={yScale(p.close)} r={7} fill="hsl(var(--accent))" opacity={0.22} />
                  <circle cx={cx} cy={yScale(p.close)} r={3.2} fill="hsl(var(--accent))" />
                </>
              ) : null}
            </g>
          );
        })}
      </g>
    );
  };
}

export default function EquityPanel({ startingBalance = 10000, dailyTargetPct = 2, liveEquity = null }) {
  const [state, setState] = useState({ loading: true, points: [], stats: null, error: null });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const closed = await base44.entities.Trade.filter(
          { status: 'closed', mode: 'paper' },
          { sort: 'closed_at', limit: 1000, fields: ['pnl_usd', 'closed_at'] },
        );
        const trades = closed.items || [];
        if (cancelled) return;

        // fold each closed trade into its day to build daily open / high / low / close
        const todayKey = new Date().toISOString().slice(0, 10);
        const byDay = new Map();
        let running = Number(startingBalance) || 0;
        for (const t of trades) {
          const key = String(t.closed_at || '').slice(0, 10);
          if (!key) continue;
          const pnl = Number(t.pnl_usd) || 0;
          let day = byDay.get(key);
          if (!day) {
            day = { key, open: running, high: running, low: running, close: running, pnl: 0 };
            byDay.set(key, day);
          }
          running += pnl;
          day.close = running;
          day.high = Math.max(day.high, running);
          day.low = Math.min(day.low, running);
          day.pnl += pnl;
        }

        const points = [...byDay.values()].map((d) => ({
          day: d.key,
          label: d.key === todayKey ? 'Today' : format(parseISO(d.key), 'MMM d'),
          open: d.open,
          close: d.close,
          high: d.high,
          low: d.low,
          equity: d.close,
          pnl: d.pnl,
          live: false,
        }));

        // today's live candle: the open is where the day started, the close is
        // where the whole position stands right now (cash + exposure + P&L)
        const live = Number(liveEquity);
        if (Number.isFinite(live) && live > 0) {
          const last = points[points.length - 1];
          if (last && last.day === todayKey) {
            last.close = live;
            last.equity = live;
            last.high = Math.max(last.high, live);
            last.low = Math.min(last.low, live);
            last.live = true;
          } else {
            const open = last ? last.close : Number(startingBalance) || 0;
            points.push({
              day: todayKey,
              label: 'Today',
              open,
              close: live,
              high: Math.max(open, live),
              low: Math.min(open, live),
              equity: live,
              pnl: 0,
              live: true,
            });
          }
        }

        const wins = trades.filter((t) => (Number(t.pnl_usd) || 0) > 0);
        const losses = trades.filter((t) => (Number(t.pnl_usd) || 0) < 0);
        const grossProfit = wins.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);
        const grossLoss = losses.reduce((a, t) => a + (Number(t.pnl_usd) || 0), 0);
        const net = grossProfit + grossLoss;

        setState({
          loading: false,
          error: null,
          points,
          stats: {
            net,
            trades: trades.length,
            wins: wins.length,
            losses: losses.length,
            winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
            profitFactor: grossLoss ? grossProfit / Math.abs(grossLoss) : null,
            avgWin: wins.length ? grossProfit / wins.length : 0,
            avgLoss: losses.length ? grossLoss / losses.length : 0,
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
  }, [startingBalance, liveEquity]);

  const { stats, points, loading, error } = state;
  const net = stats?.net || 0;

  const lows = points.map((p) => p.low);
  const highs = points.map((p) => p.high);
  const pad = points.length ? Math.max((Math.max(...highs) - Math.min(...lows)) * 0.1, 10) : 0;
  const yDomain = points.length ? [Math.min(...lows) - pad, Math.max(...highs) + pad] : ['auto', 'auto'];

  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Paper equity</p>
        <span className="num text-[11px] text-muted-foreground">target {fmtPct(dailyTargetPct)} / day</span>
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">Adding up your closed trades…</p>
      ) : error ? (
        <p className="mt-4 text-sm text-destructive">{error}</p>
      ) : points.length === 0 ? (
        <div className="mt-4 space-y-1">
          <p className="num text-3xl font-semibold">{fmtUsd(startingBalance)}</p>
          <p className="text-sm text-muted-foreground">
            No closed trades yet — the candles build as the bot takes profit or stops out.
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
            <span className={`num text-sm ${net >= 0 ? 'text-primary' : 'text-destructive'}`}>
              {fmtPct((net / (startingBalance || 1)) * 100)}
            </span>
          </div>

          <div className="mt-3 h-52">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={points} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.3} vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={24}
                />
                <YAxis
                  orientation="right"
                  domain={yDomain}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={62}
                  tickFormatter={(v) => `$${Math.round(Number(v) / 100) / 10}k`}
                />
                <Tooltip content={<EquityTooltip />} cursor={{ stroke: 'hsl(var(--border))' }} />
                <Line
                  type="monotone"
                  dataKey="equity"
                  stroke="hsl(var(--accent))"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <Customized component={renderCandles(points)} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Each candle is one day of equity (open, high, low, close) · the cyan line tracks where your position stands
            right now.
          </p>

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