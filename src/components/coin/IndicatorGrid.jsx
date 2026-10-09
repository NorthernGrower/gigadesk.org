import React from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import ScoreBreakdown from '@/components/coin/ScoreBreakdown';
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

function adxHint(adx, plusDi, minusDi) {
  if (adx >= 25) return `${plusDi > minusDi ? 'Buyers' : 'Sellers'} in control`;
  if (adx >= 20) return 'Mild trend';
  return 'Choppy — no trend';
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
  const StructureIcon = i.structure === 'up' ? ArrowUpRight : i.structure === 'down' ? ArrowDownRight : Minus;

  const squeeze =
    i.bb_width_percentile == null
      ? '—'
      : i.bb_width_percentile <= 25
        ? 'Squeezed'
        : i.bb_width_percentile >= 85
          ? 'Expanded'
          : 'Normal';

  const vwapHint =
    i.vwap_dist_pct == null
      ? 'Not enough data'
      : i.vwap_dist_pct >= 0
        ? `${fmtPct(i.vwap_dist_pct, 2)} above VWAP`
        : `${fmtPct(i.vwap_dist_pct, 2)} below VWAP`;

  return (
    <div className="space-y-3">
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

        <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Structure</p>
          <p
            className={`mt-1 flex items-center gap-1.5 text-sm font-medium ${
              i.structure === 'up' ? 'text-primary' : i.structure === 'down' ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            <StructureIcon className="h-4 w-4" />
            {i.structure === 'up' ? 'Higher highs' : i.structure === 'down' ? 'Lower lows' : 'Ranging'}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Higher timeframe {i.htf_trend || 'unknown'}
          </p>
        </div>

        <Cell
          label="ADX 14"
          value={Number(i.adx || 0).toFixed(1)}
          hint={adxHint(Number(i.adx || 0), Number(i.plus_di || 0), Number(i.minus_di || 0))}
          tone={Number(i.adx || 0) >= 25 ? (Number(i.plus_di || 0) > Number(i.minus_di || 0) ? 'up' : 'down') : 'flat'}
        />
        <Cell label="RSI 14" value={Number(i.rsi || 0).toFixed(1)} hint={rsiHint(i.rsi)} tone={rsiTone(i.rsi)} />
        <Cell
          label="Stochastic"
          value={Number(i.stoch_k || 0).toFixed(1)}
          hint={
            Number(i.stoch_k || 0) > Number(i.stoch_d || 0)
              ? `%D ${Number(i.stoch_d || 0).toFixed(1)} · turning up`
              : `%D ${Number(i.stoch_d || 0).toFixed(1)} · turning down`
          }
          tone={Number(i.stoch_k || 0) > Number(i.stoch_d || 0) ? 'up' : 'down'}
        />
        <Cell
          label="MACD hist"
          value={Number(i.macd_hist || 0).toFixed(4)}
          hint={(i.macd_hist || 0) >= 0 ? 'Momentum up' : 'Momentum down'}
          tone={(i.macd_hist || 0) >= 0 ? 'up' : 'down'}
        />
        <Cell
          label="VWAP"
          value={i.vwap ? fmtPrice(i.vwap) : '—'}
          hint={vwapHint}
          tone={i.vwap_dist_pct == null ? 'flat' : i.vwap_dist_pct >= 0 ? 'up' : 'down'}
        />
        <Cell
          label="OBV flow"
          value={fmtPct(i.obv_change_pct, 1)}
          hint={(i.obv_change_pct || 0) >= 1 ? 'Accumulating' : (i.obv_change_pct || 0) <= -1 ? 'Distributing' : 'Flat'}
          tone={(i.obv_change_pct || 0) >= 1 ? 'up' : (i.obv_change_pct || 0) <= -1 ? 'down' : 'flat'}
        />
        <Cell label="Volume vs avg" value={`${Number(i.vol_ratio || 0).toFixed(2)}x`} hint={(i.vol_ratio || 0) >= 1.3 ? 'Heavy' : 'Normal'} />
        <Cell label="EMA 20" value={fmtPrice(i.ema20)} hint={vs(i.ema20).label} tone={vs(i.ema20).tone} />
        <Cell label="EMA 50" value={fmtPrice(i.ema50)} hint={vs(i.ema50).label} tone={vs(i.ema50).tone} />
        <Cell
          label="EMA 200"
          value={i.ema200 ? fmtPrice(i.ema200) : '—'}
          hint={i.ema200 ? vs(i.ema200).label : 'Not enough history'}
          tone={i.ema200 ? vs(i.ema200).tone : 'flat'}
        />
        <Cell label="Bollinger pos." value={band.value} hint={band.hint} />
        <Cell label="Volatility" value={`${Number(i.atr_pct || 0).toFixed(2)}%`} hint={`ATR · bands ${squeeze}`} />
        <Cell label="Support" value={i.support ? fmtPrice(i.support) : '—'} hint={`Last swing low ${i.swing_low ? fmtPrice(i.swing_low) : '—'}`} />
        <Cell label="Resistance" value={i.resistance ? fmtPrice(i.resistance) : '—'} hint={`Last swing high ${i.swing_high ? fmtPrice(i.swing_high) : '—'}`} />
        <Cell
          label="Divergence"
          value={i.rsi_divergence ? `${i.rsi_divergence[0].toUpperCase()}${i.rsi_divergence.slice(1)}` : 'None'}
          hint="Price vs RSI at the swings"
          tone={i.rsi_divergence === 'bullish' ? 'up' : i.rsi_divergence === 'bearish' ? 'down' : 'flat'}
        />
        <Cell label="Last candle" value={i.pattern || 'none'} hint={`Room to level ${fmtPct(snapshot.room_pct, 1)}`} />
      </div>

      <ScoreBreakdown
        categories={snapshot.categories}
        confluence={snapshot.confluence}
        quality={snapshot.quality}
      />
    </div>
  );
}