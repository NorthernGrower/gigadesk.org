import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import FiltersBar from '@/components/screener/FiltersBar';
import ScreenerTable from '@/components/screener/ScreenerTable';
import LiveScannedCoins from '@/components/screener/LiveScannedCoins';
import { ErrorNotice, LoadingBlock } from '@/components/common/States';
import { useToast } from '@/components/ui/use-toast';
import { ensureBotConfig, pageItems, scanMarket } from '@/lib/market';

export default function Screener() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [timeframe, setTimeframe] = useState('1h');
  const [tier, setTier] = useState('all');
  const [depth, setDepth] = useState('70');
  const [minScore, setMinScore] = useState(0);
  const [targetOnly, setTargetOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [watchSymbols, setWatchSymbols] = useState([]);
  const [targetPct, setTargetPct] = useState(2);

  const scan = async (options = {}) => {
    setLoading(true);
    setError(null);
    try {
      const data = await scanMarket({
        timeframe: options.timeframe || timeframe,
        scope: options.tier || tier,
        count: Number(options.depth || depth),
        dailyTargetPct: options.targetPct || targetPct,
        persist: options.persist !== false,
        symbols: options.symbols || watchSymbols,
      });
      setBoard(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [config, watch] = await Promise.all([
          ensureBotConfig(),
          base44.entities.Watchlist.filter({}, { limit: 100 }),
        ]);
        const symbols = pageItems(watch).map((row) => row.symbol);
        const target = Number(config.daily_target_pct) || 2;
        if (!alive) return;
        setWatchSymbols(symbols);
        setTargetPct(target);
        await scan({ timeframe: '1h', tier: 'all', depth: '70', targetPct: target, symbols });
      } catch (err) {
        if (alive) {
          setError(err.message);
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggleWatch = async (row) => {
    try {
      const existing = pageItems(
        await base44.entities.Watchlist.filter({ symbol: row.symbol }, { limit: 1 }),
      )[0];
      if (existing) {
        await base44.entities.Watchlist.delete(existing.id);
        setWatchSymbols((prev) => prev.filter((symbol) => symbol !== row.symbol));
        toast({ title: `${row.symbol} removed from your watchlist` });
      } else {
        await base44.entities.Watchlist.create({ symbol: row.symbol, name: row.name || row.symbol });
        setWatchSymbols((prev) => [...prev, row.symbol]);
        toast({ title: `${row.symbol} added to your watchlist` });
      }
    } catch (err) {
      toast({ title: 'Watchlist update failed', description: err.message, variant: 'destructive' });
    }
  };

  const rows = (board?.rows || []).filter(
    (row) =>
      row.score >= minScore &&
      (!targetOnly || row.meets_daily_target) &&
      (!query.trim() || row.symbol.includes(query.trim().toUpperCase())),
  );

  return (
    <div className="space-y-4">
      <FiltersBar
        timeframe={timeframe}
        onTimeframe={(value) => {
          setTimeframe(value);
          scan({ timeframe: value });
        }}
        tier={tier}
        onTier={(value) => {
          setTier(value);
          scan({ tier: value });
        }}
        minScore={minScore}
        onMinScore={setMinScore}
        targetOnly={targetOnly}
        onTargetOnly={setTargetOnly}
        query={query}
        onQuery={setQuery}
        depth={depth}
        onDepth={(value) => {
          setDepth(value);
          scan({ depth: value });
        }}
        onRescan={() => scan({ persist: true })}
        loading={loading}
        targetPct={targetPct}
        lastUpdated={board?.updatedAt}
        scanned={board?.scannedCount}
      />

      {error ? <ErrorNotice message={error} onRetry={() => scan()} /> : null}

      {loading && !board ? (
        <LoadingBlock label="Pulling candles for the strongest movers in the market" />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <p className="text-[11px] text-muted-foreground">
              {board?.exchangeFilter
                ? `${rows.length} of ${board?.scannedCount || 0} analysed setups shown · candidates drawn from the ${board.exchangeFilter.listed} pairs listed on ${board.exchangeFilter.label} (of ${board?.universeCount || 0} tradable markets)`
                : `${rows.length} of ${board?.scannedCount || 0} analysed setups shown · ${board?.universeCount || 0} tradable markets scanned for candidates`}
            </p>
            {board?.medianChange24h !== undefined ? (
              <p className="num text-[11px] text-muted-foreground">
                market median {board.medianChange24h > 0 ? '+' : ''}
                {Number(board.medianChange24h).toFixed(2)}% today
              </p>
            ) : null}
          </div>
          <ScreenerTable
            rows={rows}
            onSelect={(row) => navigate(`/coin/${row.symbol}`)}
            onWatch={toggleWatch}
            watchSymbols={watchSymbols}
            targetPct={targetPct}
          />
          <LiveScannedCoins />
        </>
      )}
    </div>
  );
}