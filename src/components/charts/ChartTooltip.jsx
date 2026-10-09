import React from 'react';
import { fmtPrice } from '@/lib/format';

export default function ChartTooltip({ active, payload, kind = 'price' }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;

  const Line = ({ label, value, tone }) => (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={`num ${tone || 'text-foreground'}`}>{value}</span>
    </div>
  );

  return (
    <div className="min-w-[170px] rounded-xl border border-border bg-popover/95 px-3 py-2 text-[11px] shadow-xl backdrop-blur">
      {kind === 'price' ? (
        <div className="space-y-1">
          <Line label="Open" value={fmtPrice(row.o)} />
          <Line label="High" value={fmtPrice(row.h)} />
          <Line label="Low" value={fmtPrice(row.l)} />
          <Line label="Close" value={fmtPrice(row.c)} tone={row.c >= row.o ? 'text-primary' : 'text-destructive'} />
          {row.ema50 ? <Line label="EMA 50" value={fmtPrice(row.ema50)} /> : null}
          {row.bbUpper ? <Line label="BB upper" value={fmtPrice(row.bbUpper)} /> : null}
        </div>
      ) : null}
      {kind === 'rsi' ? <Line label="RSI 14" value={Number(row.rsi || 0).toFixed(1)} /> : null}
      {kind === 'macd' ? (
        <div className="space-y-1">
          <Line label="MACD" value={Number(row.macd || 0).toFixed(4)} />
          <Line label="Signal" value={Number(row.macdSignal || 0).toFixed(4)} />
          <Line
            label="Histogram"
            value={Number(row.macdHist || 0).toFixed(4)}
            tone={(row.macdHist || 0) >= 0 ? 'text-primary' : 'text-destructive'}
          />
        </div>
      ) : null}
    </div>
  );
}