import React, { useMemo } from 'react';
import { format } from 'date-fns';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ChartTooltip from '@/components/charts/ChartTooltip';
import { fmtPrice } from '@/lib/format';

const UP = 'hsl(var(--primary))';
const DOWN = 'hsl(var(--destructive))';
const HEIGHT = 340;
const MARGIN = { top: 14, right: 4, bottom: 4, left: 4 };

export default function CandleChart({ candles = [], dateFormat = 'HH:mm' }) {
  const data = useMemo(() => {
    const slice = candles.slice(-140);
    return slice.map((d) => ({ ...d, range: [d.l, d.h] }));
  }, [candles]);

  if (!data.length) {
    return <div className="flex h-[340px] items-center justify-center text-sm text-muted-foreground">No candles for this timeframe yet</div>;
  }

  // Drawn from the bar's own pixel geometry, so the candles always line up with the axis.
  const Candle = ({ x, width, y, height, payload }) => {
    const { o, h, l, c } = payload;
    if (!(h > l) || !height) return null;
    const scale = height / (h - l);
    const yOf = (v) => y + (h - v) * scale;
    const color = c >= o ? UP : DOWN;
    const bodyWidth = Math.max(1, width * 0.6);
    const cx = x + width / 2;
    return (
      <g>
        <line x1={cx} y1={yOf(h)} x2={cx} y2={yOf(l)} stroke={color} strokeWidth={1} />
        <rect
          x={cx - bodyWidth / 2}
          y={Math.min(yOf(o), yOf(c))}
          width={bodyWidth}
          height={Math.max(1, Math.abs(yOf(c) - yOf(o)))}
          fill={color}
          rx={0.5}
        />
      </g>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <ComposedChart data={data} margin={MARGIN}>
        <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
        <XAxis
          dataKey="t"
          tickFormatter={(t) => format(new Date(t), dateFormat)}
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          minTickGap={40}
        />
        <YAxis
          orientation="right"
          domain={['auto', 'auto']}
          tickFormatter={fmtPrice}
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={66}
          scale="linear"
        />
        <Tooltip content={<ChartTooltip kind="price" />} cursor={{ stroke: 'hsl(var(--border))' }} />
        <Line dataKey="bbUpper" stroke="hsl(var(--accent))" strokeOpacity={0.35} strokeWidth={1} dot={false} connectNulls isAnimationActive={false} />
        <Line dataKey="bbLower" stroke="hsl(var(--accent))" strokeOpacity={0.35} strokeWidth={1} dot={false} connectNulls isAnimationActive={false} />
        <Bar dataKey="range" shape={<Candle />} isAnimationActive={false} />
        <Line dataKey="ema200" stroke="hsl(var(--muted-foreground))" strokeWidth={1.1} dot={false} connectNulls isAnimationActive={false} />
        <Line dataKey="ema50" stroke="hsl(var(--chart-4))" strokeWidth={1.1} dot={false} connectNulls isAnimationActive={false} />
        <Line dataKey="ema20" stroke="hsl(var(--chart-3))" strokeWidth={1.1} dot={false} connectNulls isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}