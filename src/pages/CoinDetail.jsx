import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Star } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import AnalysisPanel from '@/components/coin/AnalysisPanel';
import BotRuleCheck from '@/components/coin/BotRuleCheck';
import IndicatorGrid from '@/components/coin/IndicatorGrid';
import TradeTicket from '@/components/coin/TradeTicket';
import ChartWorkspace from '@/components/charts/ChartWorkspace';
import CoinAvatar from '@/components/common/CoinAvatar';
import { ErrorNotice, LoadingBlock } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { TIER_LABEL, ensureBotConfig, getCoinDetail, pageItems } from '@/lib/market';
import { fmtCompactUsd, fmtPct, fmtPrice } from '@/lib/format';

export default function CoinDetail() {
  const { symbol = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const btcMode = searchParams.get('quote') === 'BTC';
  const quote = btcMode ? 'BTC' : 'USD';

  const [timeframe, setTimeframe] = useState('1h');
  const [detail, setDetail] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const [watched, setWatched] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await ensureBotConfig();
        if (alive) setConfig(cfg);
      } catch {
        // the bot check simply stays hidden without a config
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      setAnalysis(null);
      try {
        const data = await getCoinDetail(symbol, timeframe, false, quote);
        if (!alive) return;
        setDetail(data);
        if (searchParams.get('ai') === '1') {
          generateAnalysis();
        }
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    const loadWatch = async () => {
      const existing = pageItems(await base44.entities.Watchlist.filter({ symbol }, { limit: 1 }))[0];
      if (alive) setWatched(Boolean(existing));
    };
    loadWatch();
    return () => {
      alive = false;
    };
  }, [symbol, timeframe, quote]);

  const generateAnalysis = async () => {
    setAiLoading(true);
    try {
      const data = await getCoinDetail(symbol, timeframe, true, quote);
      setDetail(data);
      setAnalysis(data.analysis);
      if (!data.analysis) {
        toast({ title: 'The AI read came back empty', description: 'Try again in a moment.' });
      }
    } catch (err) {
      toast({ title: 'Could not generate the read', description: err.message, variant: 'destructive' });
    } finally {
      setAiLoading(false);
    }
  };

  const toggleWatch = async () => {
    try {
      const existing = pageItems(await base44.entities.Watchlist.filter({ symbol }, { limit: 1 }))[0];
      if (existing) {
        await base44.entities.Watchlist.delete(existing.id);
        setWatched(false);
        toast({ title: `${symbol} removed from your watchlist` });
      } else {
        await base44.entities.Watchlist.create({
          symbol,
          name: detail?.coin?.name || symbol,
        });
        setWatched(true);
        toast({ title: `${symbol} added to your watchlist` });
      }
    } catch (err) {
      toast({ title: 'Watchlist update failed', description: err.message, variant: 'destructive' });
    }
  };

  const snapshot = detail?.snapshot;
  const coin = detail?.coin;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <CoinAvatar symbol={symbol} size="lg" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading text-xl font-semibold">{coin?.name || symbol}</h1>
              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {btcMode ? 'BTC pair' : TIER_LABEL[coin?.market_cap_bucket] || 'tier'}
              </span>
            </div>
            {coin ? (
              <div className="num mt-1 flex flex-wrap items-center gap-2.5 text-sm">
                <span>{fmtPrice(coin.price)}</span>
                <span className={coin.change24h >= 0 ? 'text-primary' : 'text-destructive'}>
                  {fmtPct(coin.change24h)} 24h
                </span>
                <span className={coin.change7d >= 0 ? 'text-primary' : 'text-destructive'}>
                  {fmtPct(coin.change7d)} 7d
                </span>
                <span className="text-muted-foreground">{fmtCompactUsd(coin.volume24h)} traded</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={toggleWatch}>
            <Star className={`mr-2 h-3.5 w-3.5 ${watched ? 'fill-primary text-primary' : ''}`} />
            {watched ? 'Watching' : 'Watch'}
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/screener">Back to the screener</Link>
          </Button>
        </div>
      </div>

      {error ? <ErrorNotice message={error} onRetry={() => setTimeframe(timeframe)} /> : null}

      {loading && !detail ? (
        <LoadingBlock label={`Charting ${symbol} across ${timeframe} candles`} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <ChartWorkspace
              detail={detail}
              timeframe={timeframe}
              onTimeframeChange={setTimeframe}
              loading={loading}
            />
            {snapshot ? <IndicatorGrid snapshot={snapshot} /> : null}
          </div>
          <div className="space-y-4">
            <AnalysisPanel
              snapshot={snapshot}
              analysis={analysis}
              loading={aiLoading}
              onGenerate={generateAnalysis}
            />
            <BotRuleCheck snapshot={snapshot} config={config} />
            {!btcMode ? <TradeTicket snapshot={snapshot} /> : (
              <p className="surface p-4 text-[11px] leading-snug text-muted-foreground">
                This is the BTC-quoted pair. The desk trades it through the Bitcoin books on the Bot page, in BTC — the dollar ticket is not available here.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}