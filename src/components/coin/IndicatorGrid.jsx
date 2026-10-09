import React from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { fmtPct, fmtPrice } from '@/lib/format';

function Cell({ label, value, hint, tone }) {
  const tones = {
    up: 'text-primary',
    down: 'text-destructive',
    flat: 'text-muted-foreground',
  };
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`num mt-1 text-sm font-medium ${tones[tone] || 'text-foreground'}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function rsiTone(v) {
  if (v >= 70) return 'down';
  if (v <= 30) return 'up';
  return 'flat';
}

function rsiHint(v) {
  if (v >= 78) return 'Overbought';
  if (v >= 60) return 'Strong';
  if (v >= 45) return 'Neutral';
  if (v >= 30) return 'Weakening';
  return 'Oversold';
}

export default function IndicatorGrid({ snapshot }) {
  if (!snapshot) return null;
  const i = snapshot.indicators || {};
  const price = Number(snapshot.price) || 0;

  const vs = (value) => {
    if (value == null) return { label: '—', tone: 'flat' };
    const diff = ((price - value) / value) * 100;
    return { label: fmtPct(diff, 1), tone: diff >= 0 ? 'up' : 'down' };
  };

  const bandPosition = () => {
    if (i.bb_upper == null || i.bb_lower == null) return { value: '—', hint: '' };
    const span = i.bb_upper - i.bb_lower;
    if (span <= 0) return { value: '—', hint: '' };
    const pos = ((price - i.bb_lower) / span) * 100;
    return {
      value: `${Math.round(Math.max(0, Math.min(100, pos)))}%`,
      hint: pos > 100 ? 'Above the upper band' : pos < 0 ? 'Below the lower band' : 'Inside the bands',
    };
  };

  const band = bandPosition();
  const TrendIcon = i.trend === 'up' ? ArrowUpRight : i.trend === 'down' ? ArrowDownRight : Minus;

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
      <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5">
        <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Trend</p>
        <p
          className={`mt-1 flex items-center gap-1.5 text-sm font-medium ${
            i.trend === 'up' ? 'text-primary' : i.trend === 'down' ? 'text-destructive' : 'text-muted-foreground'
          }`}
        >
          <TrendIcon className="h-4 w-4" />
          {i.trend === 'up' ? 'Uptrend' : i.trend === 'down' ? 'Downtrend' : 'Sideways'}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">Slope {fmtPct(i.ema50_slope, 2)}</p>
      </div>

      <Cell label="RSI 14" value={Number(i.rsi || 0).toFixed(1)} hint={rsiHint(i.rsi)} tone={rsiTone(i.rsi)} />
      <Cell
        label="MACD hist"
        value={Number(i.macd_hist || 0).toFixed(4)}
        hint={(i.macd_hist || 0) >= 0 ? 'Momentum up' : 'Momentum down'}
        tone={(i.macd_hist || 0) >= 0 ? 'up' : 'down'}
      />
      <Cell label="Volume vs avg" value={`${Number(i.vol_ratio || 0).toFixed(2)}x`} hint={(i.vol_ratio || 0) >= 1.3 ? 'Heavy' : 'Normal'} />
      <Cell label="EMA 20" value={fmtPrice(i.ema20)} hint={vs(i.ema20).label} tone={vs(i.ema20).tone} />
      <Cell label="EMA 50" value={fmtPrice(i.ema50)} hint={vs(i.ema50).label} tone={vs(i.ema50).tone} />
      <Cell label="EMA 200" value={i.ema200 ? fmtPrice(i.ema200) : '—'} hint={i.ema200 ? vs(i.ema200).label : 'Not enough history'} tone={i.ema200 ? vs(i.ema200).tone : 'flat'} />
      <Cell label="Bollinger pos." value={band.value} hint={band.hint} />
      <Cell label="ATR" value={`${Number(i.atr_pct || 0).toFixed(2)}%`} hint="Average true range" />
      <Cell label="Support" value={i.support ? fmtPrice(i.support) : '—'} hint="Nearest floor" />
      <Cell label="Resistance" value={i.resistance ? fmtPrice(i.resistance) : '—'} hint="Nearest ceiling" />
    </div>
  );
}