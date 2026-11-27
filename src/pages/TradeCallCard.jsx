import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ListChecks, Loader2, Sparkles, TrendingUp, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import CandleChart from '@/components/charts/CandleChart';
import CoinAvatar from '@/components/common/CoinAvatar';
import IndicatorGrid from '@/components/coin/IndicatorGrid';
import { EmptyState, LoadingBlock } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/use-toast';
import { VERDICT_LABEL, ensureBotConfig, getCoinDetail, tradeAction } from '@/lib/market';
import { fmtDate, fmtPct, fmtPrice, fmtUsd } from '@/lib/format';
import { tradeHash } from '@/lib/tradeHash';

function Stat({ label, value, tone = 'text-foreground', hint }) {
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`num mt-1 text-sm font-medium ${tone}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SectionHead({ icon: Icon, title, sub }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h2 className="font-heading text-sm font-semibold">{title}</h2>
      </div>
      {sub ? <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export default function TradeCallCard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [trade, setTrade] = useState(null);
  const [signal, setSignal] = useState(null);
  const [detail, setDetail] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [savingHandling, setSavingHandling] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setMissing(false);
    setTrade(null);
    setDetail(null);
    setAnalysis(null);
    setSignal(null);
    setDetailFailed(false);
    (async () => {
      try {
        const t = await base44.entities.Trade.get(id);
        if (!t) {
          if (alive) setMissing(true);
          return;
        }
        if (!alive) return;
        setTrade(t);
        const cfg = await ensureBotConfig().catch(() => null);
        const timeframe = (cfg && cfg.timeframe) || '1h';
        // the trade frame renders at once; chart and AI read fill in as they land
        let coinData = null;
        try {
          coinData = await getCoinDetail(t.symbol, timeframe, true);
        } catch {
          coinData = null;
        }
        if (!alive) return;
        setDetail(coinData);
        setAnalysis(coinData ? coinData.analysis || null : null);
        setDetailFailed(!coinData);
        const linkedSignal = t.signal_id
          ? await base44.entities.Signal.get(t.signal_id).catch(() => null)
          : null;
        if (!alive) return;
        setSignal(linkedSignal);
      } catch {
        if (alive) setMissing(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  // live: any change to this trade refreshes the card in place
  useEffect(() => {
    if (!id) return undefined;
    return base44.entities.Trade.subscribe((event) => {
      if (event && event.id === id) {
        base44.entities.Trade.get(id).then(setTrade).catch(() => setMissing(true));
      }
    });
  }, [id]);

  const closeTrade = async () => {
    if (!trade) return;
    setClosing(true);
    try {
      const res = await tradeAction('close', trade.id);
      toast({
        title: `${trade.symbol} closed`,
        description: `${fmtUsd(res.pnl_usd)} booked at ${fmtPrice(res.exit_price)}.`,
      });
      setTrade(await base44.entities.Trade.get(trade.id));
    } catch (err) {
      toast({ title: 'Could not close the trade', description: err.message, variant: 'destructive' });
    } finally {
      setClosing(false);
    }
  };

  // bot handling: off (manual mode) = the desk leaves the trade alone; on =
  // the bot manages the sell logic only — stop, target and trailing, never a
  // sentiment flip or thesis-decay close on a manual buy
  const handlingOn = trade ? trade.bot_handling !== false : true;
  const toggleHandling = async (next) => {
    const prev = trade;
    setTrade({ ...trade, bot_handling: next });
    setSavingHandling(true);
    try {
      await base44.entities.Trade.update(trade.id, { bot_handling: next });
      toast({
        title: next ? 'Bot handling on' : 'Manual mode on',
        description: next
          ? "The bot manages this trade's sell logic from the next cycle."
          : 'The desk leaves this trade alone entirely.',
      });
    } catch (err) {
      setTrade(prev);
      toast({ title: 'Could not update bot handling', description: err.message, variant: 'destructive' });
    } finally {
      setSavingHandling(false);
    }
  };

  if (loading) return <LoadingBlock label="Building the call card" />;

  if (missing || !trade) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12">
        <EmptyState
          title="Trade not found"
          description="This trade may have been removed from the journal."
        />
        <div className="mt-4 text-center">
          <Button variant="outline" asChild>
            <Link to="/journal">Back to the journal</Link>
          </Button>
        </div>
      </div>
    );
  }

  const snapshot = detail?.snapshot || null;
  const isShort = trade.side === 'short';
  const open = trade.status === 'open';
  const livePrice = detail?.coin?.price;
  const livePnl =
    open && livePrice && Number(trade.quantity)
      ? (isShort ? Number(trade.entry_price) - livePrice : livePrice - Number(trade.entry_price)) * Number(trade.quantity)
      : null;
  const livePnlPct = livePnl != null && Number(trade.size_usd) ? (livePnl / Number(trade.size_usd)) * 100 : null;
  const reasons = (trade.rationale ? String(trade.rationale).split(' • ') : []).filter(Boolean);
  const signalReasons = signal?.reasons?.length ? signal.reasons : snapshot?.reasons || [];
  const verdict = analysis?.verdict ? VERDICT_LABEL[analysis.verdict] || analysis.verdict : null;
  const verdictTone = ['strong_long', 'long'].includes(analysis?.verdict)
    ? 'text-primary'
    : ['short', 'strong_short', 'avoid'].includes(analysis?.verdict)
      ? 'text-destructive'
      : 'text-foreground';

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="icon" variant="ghost" onClick={() => navigate(-1)} title="Go back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <CoinAvatar symbol={trade.symbol} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h1 className="font-display text-lg font-semibold">{trade.symbol}</h1>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase ${
                isShort ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
              }`}
            >
              {trade.side}
            </span>
            <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {trade.mode === 'real' ? 'real money' : 'paper'}
            </span>
            {trade.manual ? (
              <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-accent">
                manual buy
              </span>
            ) : null}
            {trade.id ? (
              <span
                className="num rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                title="Trade hash — the journal's reference for this trade"
              >
                #{tradeHash(trade)}
              </span>
            ) : null}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase ${
                open ? 'bg-accent/15 text-accent' : 'bg-secondary text-muted-foreground'
              }`}
            >
              {trade.status}
              {trade.exit_reason ? ` · ${trade.exit_reason}` : ''}
            </span>
          </div>
          <p className="num mt-0.5 text-[11px] text-muted-foreground">
            Opened {fmtDate(trade.opened_at || trade.created_date)}
            {trade.closed_at ? ` · Closed ${fmtDate(trade.closed_at)}` : ''}
          </p>
        </div>
        {open ? (
          <Button variant="outline" className="hover:border-destructive/60 hover:text-destructive" onClick={closeTrade} disabled={closing}>
            {closing ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            Close trade
          </Button>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Entry" value={fmtPrice(trade.entry_price)} />
        <Stat label="Stop" value={trade.stop_price ? fmtPrice(trade.stop_price) : '—'} tone="text-destructive" />
        <Stat label="Target" value={trade.target_price ? fmtPrice(trade.target_price) : '—'} tone="text-primary" />
        <Stat label="Size" value={trade.size_usd ? fmtUsd(trade.size_usd) : '—'} hint={trade.quantity ? `${trade.quantity} units` : undefined} />
        {trade.status === 'closed' ? (
          <Stat
            label="P&L"
            value={fmtUsd(trade.pnl_usd || 0)}
            tone={(trade.pnl_usd || 0) >= 0 ? 'text-primary' : 'text-destructive'}
            hint={`${fmtPct(trade.pnl_pct || 0)}`}
          />
        ) : livePnl != null ? (
          <Stat
            label="P&L (live)"
            value={fmtUsd(livePnl)}
            tone={livePnl >= 0 ? 'text-primary' : 'text-destructive'}
            hint={`${fmtPct(livePnlPct || 0)} · at ${fmtPrice(livePrice)}`}
          />
        ) : (
          <Stat label="P&L" value="—" hint={trade.status === 'proposed' ? 'Awaiting approval' : undefined} />
        )}
      </div>

      {open && trade.mode === 'real' ? (
        <div className="surface mt-2.5 flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="font-heading text-sm font-semibold">
              Bot handling{trade.manual ? ' · manual buy' : ''}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {handlingOn
                ? 'The bot manages the sell logic only: stop, target and trailing. It never sentiment-sells this trade.'
                : 'Manual mode — the desk leaves this trade alone entirely. Turn on for stop, target and trailing management.'}
            </p>
          </div>
          <Switch checked={handlingOn} onCheckedChange={toggleHandling} disabled={savingHandling} />
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="surface p-4">
            <SectionHead icon={TrendingUp} title="Chart" sub={detail?.timeframe ? `${trade.symbol} · ${detail.timeframe} candles` : undefined} />
            {detail?.candles?.length ? (
              <CandleChart candles={detail.candles} />
            ) : (
              <div className="flex h-[340px] items-center justify-center text-sm text-muted-foreground">
                Loading the chart…
              </div>
            )}
          </div>

          <div className="surface p-4">
            <SectionHead icon={ListChecks} title="Why this trade" sub="The confluence behind the entry, as the desk read it." />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-primary">
                Score {Math.round(Number(trade.score) || snapshot?.score || 0)}
              </span>
              {snapshot?.grade ? (
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  Grade {snapshot.grade}
                </span>
              ) : null}
              {snapshot?.quality ? (
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  Quality {snapshot.quality}
                </span>
              ) : null}
              {snapshot?.confluence ? (
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  {snapshot.confluence} confirmations
                </span>
              ) : null}
            </div>
            {reasons.length || signalReasons.length ? (
              <ul className="mt-3 space-y-1.5 text-[13px] leading-relaxed">
                {reasons.map((reason, i) => (
                  <li key={`reason-${i}`} className="flex gap-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                    {reason}
                  </li>
                ))}
                {signalReasons
                  .filter((r) => !reasons.includes(r))
                  .map((reason, i) => (
                    <li key={`signal-${i}`} className="flex gap-2">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                      {reason}
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No rationale was recorded with this trade.</p>
            )}
            {trade.notes ? (
              <p className="mt-3 border-t border-border/60 pt-3 text-[13px] leading-relaxed text-muted-foreground">Your notes: {trade.notes}</p>
            ) : null}
          </div>
        </div>

        <div className="space-y-4">
          <div className="surface p-4">
            <SectionHead icon={Sparkles} title="AI read on this call" sub="A fresh model assessment of the setup." />
            {analysis ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-heading text-sm font-semibold ${verdictTone}`}>{verdict}</span>
                  <span className="num text-xs text-muted-foreground">Confidence {analysis.confidence}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.max(0, Math.min(100, Number(analysis.confidence) || 0))}%` }}
                  />
                </div>
                <p className="text-[13px] leading-relaxed">{analysis.thesis}</p>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="AI entry" value={fmtPrice(analysis.entry)} />
                  <Stat label="AI target" value={fmtPrice(analysis.target)} tone="text-primary" />
                  <Stat label="AI stop" value={fmtPrice(analysis.stop)} tone="text-destructive" />
                </div>
                {analysis.setup_quality ? (
                  <p className="text-[12px] text-muted-foreground">Setup quality: {analysis.setup_quality}</p>
                ) : null}
                {analysis.invalidation ? (
                  <p className="text-[12px] text-muted-foreground">Invalidation: {analysis.invalidation}</p>
                ) : null}
                {analysis.horizon ? (
                  <p className="text-[12px] text-muted-foreground">Horizon: {analysis.horizon}</p>
                ) : null}
                {analysis.risks ? (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-[0.14em] text-destructive">Risks</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{analysis.risks}</p>
                  </div>
                ) : null}
              </div>
            ) : detailFailed ? (
              <p className="text-sm text-muted-foreground">No AI read is available for this trade right now — try reloading in a moment.</p>
            ) : (
              <p className="text-sm text-muted-foreground">Generating the AI read — the model is weighing this setup.</p>
            )}
          </div>

          {snapshot ? (
            <div className="surface p-4">
              <IndicatorGrid snapshot={snapshot} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}