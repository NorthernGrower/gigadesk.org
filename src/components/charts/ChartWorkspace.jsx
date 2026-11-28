import React from 'react';
import CandleChart from '@/components/charts/CandleChart';
import MacdPane from '@/components/charts/MacdPane';
import RsiPane from '@/components/charts/RsiPane';
import { LoadingBlock } from '@/components/common/States';
import { TIMEFRAMES } from '@/lib/market';

const DATE_FORMAT = { '15m': 'HH:mm', '1h': 'HH:mm', '4h': 'd MMM', '1d': 'd MMM' };

function Legend({ className = '', children }) {
  return (
    <span className={`flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] ${className}`}>
      {children}
    </span>
  );
}

function Dot({ color }) {
  return <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />;
}

export default function ChartWorkspace({ detail, timeframe, onTimeframeChange, loading }) {
  const dateFormat = DATE_FORMAT[timeframe] || 'HH:mm';

  return (
    <div className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <Legend className="text-muted-foreground">
          <Dot color="hsl(var(--chart-3))" /> EMA 20
          <span className="mx-1 opacity-40">·</span>
          <Dot color="hsl(var(--chart-4))" /> EMA 50
          <span className="mx-1 opacity-40">·</span>
          <Dot color="hsl(var(--muted-foreground))" /> EMA 200
          <span className="mx-1 opacity-40">·</span>
          <Dot color="hsl(var(--accent))" /> Bollinger
        </Legend>
        <div className="flex flex-wrap items-center gap-2">
          {detail?.quote === 'BTC' ? (
            <span className="rounded-lg bg-amber-400/15 px-2.5 py-1 text-[11px] font-medium text-amber-300 ring-1 ring-amber-400/30">
              Priced in BTC
            </span>
          ) : null}
          <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-secondary/40 p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.value}
                type="button"
                onClick={() => onTimeframeChange(tf.value)}
                className={`num rounded-lg px-2.5 py-1 text-[11px] transition-colors ${
                  timeframe === tf.value
                    ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <LoadingBlock label="Building the chart" />
      ) : (
        <div className="px-1 pt-1">
          <CandleChart candles={detail?.candles || []} dateFormat={dateFormat} />
          <div className="border-t border-border/60 px-3 pt-2">
            <Legend className="mb-1 text-muted-foreground">RSI 14</Legend>
            <RsiPane candles={detail?.candles || []} />
          </div>
          <div className="border-t border-border/60 px-3 pt-2 pb-2">
            <Legend className="mb-1 text-muted-foreground">MACD 12 · 26 · 9</Legend>
            <MacdPane candles={detail?.candles || []} />
          </div>
        </div>
      )}
    </div>
  );
}