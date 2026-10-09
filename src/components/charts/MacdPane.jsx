import React from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ChartTooltip from '@/components/charts/ChartTooltip';

export default function MacdPane({ candles = [] }) {
  const data = candles.slice(-140);
  if (!data.length) return null;

  return (
    <ResponsiveContainer width="100%" height={120}>
      <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
        <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.25} vertical={false} />
        <XAxis dataKey="t" hide />
        <YAxis
          orientation="right"
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={66}
          tickFormatter={(v) => Number(v).toFixed(2)}
        />
        <Tooltip content={<ChartTooltip kind="macd" />} />
        <ReferenceLine y={0} stroke="hsl(var(--border))" />
        <Bar dataKey="macdHist" isAnimationActive={false} barSize={3}>
          {data.map((d, i) => (
            <Cell
              key={`hist-${i}`}
              fill={(d.macdHist || 0) >= 0 ? 'hsl(var(--primary))' : 'hsl(var(--destructive))'}
              fillOpacity={0.55}
            />
          ))}
        </Bar>
        <Line dataKey="macd" stroke="hsl(var(--accent))" strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} />
        <Line dataKey="macdSignal" stroke="hsl(var(--chart-4))" strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}