import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Clock3, ListChecks, Sparkles } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import CandleChart from '@/components/charts/CandleChart';
import CoinAvatar from '@/components/common/CoinAvatar';
import IndicatorGrid from '@/components/coin/IndicatorGrid';
import { VERDICT_LABEL } from '@/lib/market';
import { fmtPct, fmtPrice } from '@/lib/format';

// chart x-axis labels that fit the pick's own timeframe
const CHART_FORMAT = {
  '15m': 'HH:mm',
  '1h': 'HH:mm',
  '4h': 'dd MMM HH:mm',
  '1d': 'dd MMM',
};

function Stat({ label, value, tone = 'text-foreground', hint }) {
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`num mt-1 text-sm font-medium ${tone}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * The homepage ad: one setup from the desk's top 10 of the day, laid out like
 * the desk's own call card — levels, chart, reasons, indicator grid and the
 * AI read — rotated every 24 hours.
 */
export default function FeaturedPick() {
  const [pick, setPick] = useState(null);

  useEffect(() => {
    let alive = true;
    base44.functions
      .invoke('pickOfTheDay', {})
      .then((res) => {
        if (alive) setPick(res.data?.pick || null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!pick) return null;
  const isShort = pick.side === 'short';
  const verdict = pick.ai?.verdict ? VERDICT_LABEL[pick.ai.verdict] || pick.ai.verdict : null;
  const verdictTone = ['strong_long', 'long'].includes(pick.ai?.verdict)
    ? 'text-primary'
    : ['short', 'strong_short', 'avoid'].includes(pick.ai?.verdict)
      ? 'text-destructive'
      : 'text-foreground';
  const snapshot = pick.indicators
    ? {
        price: pick.price,
        indicators: pick.indicators,
        categories: pick.categories,
        quality: pick.quality,
        confluence: pick.confluence,
        room_pct: null,
      }
    : null;

  return (
    <section className="mb-14">
      <div className="surface relative overflow-hidden p-6 md:p-8">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <span className="rounded-md bg-primary/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-primary ring-1 ring-primary/30">
            Featured call of the day
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock3 className="h-3.5 w-3.5" /> One of today's top 10 desk picks — rotated every 24 hours
          </span>
        </div>

        <div className="relative mt-6 flex flex-wrap items-center gap-3">
          <CoinAvatar symbol={pick.symbol} size="lg" />
          <div className="min-w-0">
            <p className="font-heading text-xl font-semibold leading-tight">{pick.symbol}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
                  isShort ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
                }`}
              >
                {pick.side}
              </span>
              <span className="num text-sm text-muted-foreground">{fmtPrice(pick.price)}</span>
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-primary">
                Score {Math.round(pick.score)}
              </span>
              {pick.grade ? (
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  Grade {pick.grade}
                </span>
              ) : null}
              {pick.quality ? (
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  Quality {pick.quality}
                </span>
              ) : null}
              {pick.confluence ? (
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  {pick.confluence} confirmations
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="relative mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Entry" value={fmtPrice(pick.entry)} />
          <Stat label="Target" value={fmtPrice(pick.target)} tone="text-primary" />
          <Stat label="Stop" value={fmtPrice(pick.stop)} tone="text-destructive" />
          <Stat label="Required move" value={fmtPct(pick.required_move_pct, 1)} hint="to reach the target" />
          <Stat label="Risk / reward" value={`${pick.risk_reward}:1`} hint={`${pick.market_cap_bucket || ''} cap`.trim()} />
        </div>

        <div className="relative mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="surface p-4">
            <p className="font-heading text-sm font-semibold">
              The chart
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                {pick.symbol} · {pick.timeframe} candles
              </span>
            </p>
            {pick.candles?.length ? (
              <div className="mt-2">
                <CandleChart candles={pick.candles} dateFormat={CHART_FORMAT[pick.timeframe] || 'HH:mm'} />
              </div>
            ) : (
              <div className="flex h-[340px] items-center justify-center text-sm text-muted-foreground">
                Loading the chart…
              </div>
            )}
          </div>

          <div className="surface p-4">
            <p className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" /> AI read on this call
            </p>
            {pick.ai ? (
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-heading text-sm font-semibold ${verdictTone}`}>{verdict}</span>
                  <span className="num text-xs text-muted-foreground">Confidence {pick.ai.confidence}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.max(0, Math.min(100, Number(pick.ai.confidence) || 0))}%` }}
                  />
                </div>
                <p className="text-[13px] leading-relaxed">{pick.ai.thesis}</p>
                {pick.ai.entry != null || pick.ai.target != null || pick.ai.stop != null ? (
                  <div className="grid grid-cols-3 gap-2">
                    <Stat label="AI entry" value={fmtPrice(pick.ai.entry)} />
                    <Stat label="AI target" value={fmtPrice(pick.ai.target)} tone="text-primary" />
                    <Stat label="AI stop" value={fmtPrice(pick.ai.stop)} tone="text-destructive" />
                  </div>
                ) : null}
                {pick.ai.setup_quality ? (
                  <p className="text-[12px] text-muted-foreground">Setup quality: {pick.ai.setup_quality}</p>
                ) : null}
                {pick.ai.invalidation ? (
                  <p className="text-[12px] text-muted-foreground">Invalidation: {pick.ai.invalidation}</p>
                ) : null}
                {pick.ai.horizon ? (
                  <p className="text-[12px] text-muted-foreground">Horizon: {pick.ai.horizon}</p>
                ) : null}
                {pick.ai.risks ? (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-[0.14em] text-destructive">Risks</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{pick.ai.risks}</p>
                  </div>
                ) : null}
                <p className="num text-[11px] text-muted-foreground">
                  Desk levels: entry {fmtPrice(pick.entry)} · target {fmtPrice(pick.target)} · stop {fmtPrice(pick.stop)}
                </p>
              </div>
            ) : (
              <p className="mt-3 text-[13px] text-muted-foreground">The AI read is being written — check back in a moment.</p>
            )}
          </div>
        </div>

        <div className="relative mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="surface p-4">
            <p className="flex items-center gap-2 font-heading text-sm font-semibold">
              <ListChecks className="h-4 w-4 text-primary" /> Why this call
            </p>
            {pick.reasons?.length ? (
              <ul className="mt-3 space-y-1.5 text-[13px] leading-relaxed">
                {pick.reasons.slice(0, 4).map((reason) => (
                  <li key={reason} className="flex items-start gap-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                    {reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No desk reasons were recorded with this setup.</p>
            )}
          </div>

          {snapshot ? (
            <div className="surface p-4">
              <IndicatorGrid snapshot={snapshot} />
            </div>
          ) : null}
        </div>

        <div className="relative mt-5">
          <Link
            to="/register"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Trade this on your desk <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
