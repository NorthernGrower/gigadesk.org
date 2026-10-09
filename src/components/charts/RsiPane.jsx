import React from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ChartTooltip from '@/components/charts/ChartTooltip';

export default function RsiPane({ candles = [], dateFormat = 'HH:mm' }) {
  const data = candles.slice(-140);
  if (!data.length) return null;

  return (
    <ResponsiveContainer width="100%" height={110}>
      <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
        <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.25} vertical={false} />
        <XAxis dataKey="t" hide />
        <YAxis
          orientation="right"
          domain={[0, 100]}
          ticks={[30, 50, 70]}
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={66}
        />
        <Tooltip content={<ChartTooltip kind="rsi" />} />
        <ReferenceLine y={70} stroke="hsl(var(--destructive))" strokeOpacity={0.35} strokeDasharray="3 3" />
        <ReferenceLine y={30} stroke="hsl(var(--primary))" strokeOpacity={0.35} strokeDasharray="3 3" />
        <Line
          dataKey="rsi"
          name="RSI"
          stroke="hsl(var(--accent))"
          strokeWidth={1.4}
          dot={false}
          connectNulls
          isAnimationActive={false}
          tickFormatter={(v) => Number(v).toFixed(0)}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}