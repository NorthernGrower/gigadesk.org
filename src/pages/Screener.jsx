import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import FiltersBar from '@/components/screener/FiltersBar';
import ScreenerTable from '@/components/screener/ScreenerTable';
import ManualBuyDialog from '@/components/screener/ManualBuyDialog';
import { ErrorNotice, LoadingBlock } from '@/components/common/States';
import BookSwitch from '@/components/desk/BookSwitch';
import { useToast } from '@/components/ui/use-toast';
import { ensureBotConfig, getLastBot, pageItems, scanMarket } from '@/lib/market';

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
  const [buyRow, setBuyRow] = useState(null);
  const [defaultBuyUsd, setDefaultBuyUsd] = useState(100);
  const [book, setBook] = useState('USD');
  const [config, setConfig] = useState(null);
  const isBtc = book === 'BTC';

  const scan = async (options = {}) => {
    const quote = options.quote || (isBtc ? 'BTC' : 'USD');
    // quiet = the board already shows the last scan, so this is a background refresh
    if (options.quiet !== true) setLoading(true);
    setError(null);
    try {
      const data = await scanMarket({
        timeframe: options.timeframe || timeframe,
        scope: options.tier || tier,
        count: Number(options.depth || depth),
        dailyTargetPct: options.targetPct || targetPct,
        persist: options.persist !== false && quote !== 'BTC',
        quote,
        symbols: quote === 'BTC' ? [] : options.symbols || watchSymbols,
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
        setConfig(config);
        setWatchSymbols(symbols);
        setTargetPct(target);
        // the manual-buy dialog pre-fills the live desk's fixed order size
        setDefaultBuyUsd(Number(config.live_rules?.fixed_order_usd ?? config.fixed_order_usd) || 100);
        // the desk's book decides the scanner's book too; the two pages always
        // read the same market, never a dollar board labelled as BTC
        setBook(config?.active_book === 'BTC' ? 'BTC' : 'USD');
        // revisits render the bot's last scan immediately, then the fresh
        // scan below quietly replaces it with the requested depth
        const cached = getLastBot();
        const btcView = config?.active_book === 'BTC';
        if (!btcView && cached?.top?.length) {
          setBoard({ rows: cached.top, scannedCount: cached.scanned, universeCount: cached.universe, summary: cached.summary });
          setLoading(false);
        }
        const initialBook = config?.active_book === 'BTC' ? 'BTC' : 'USD';
        await scan({ timeframe: '1h', tier: 'all', depth: '70', targetPct: target, symbols, quiet: Boolean(!btcView && cached?.top?.length), quote: initialBook === 'BTC' ? 'BTC' : 'USD' });
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

  // the Bot page's book switch saves the same choice: follow it so the scanner
  // can never show a dollar board while the desk is on the Bitcoin book
  useEffect(() => {
    const onDeskTick = (event) => {
      const next = event.detail?.config?.active_book === 'BTC' ? 'BTC' : 'USD';
      setBook((current) => {
        if (current === next) return current;
        scan({ timeframe: '1h', tier: 'all', depth: '70', quote: next, symbols: watchSymbols });
        return next;
      });
    };
    window.addEventListener('bot:tick', onDeskTick);
    return () => window.removeEventListener('bot:tick', onDeskTick);
  }, [watchSymbols]);

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

  const changeBook = (next) => {
    setBook(next);
    setBoard(null);
    if (config?.id) {
      const patch = { active_book: next };
      base44.entities.BotConfig.update(config.id, patch)
        .then(() => setConfig((prev) => (prev ? { ...prev, ...patch } : prev)))
        .catch(() => {});
    }
    scan({ timeframe: '1h', tier: 'all', depth: '70', quote: next, symbols: watchSymbols });
  };

  const rows = (board?.rows || []).filter(
    (row) =>
      row.score >= minScore &&
      (!targetOnly || row.meets_daily_target) &&
      (!query.trim() || row.symbol.includes(query.trim().toUpperCase())),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {isBtc
            ? 'Bitcoin-paired markets on your connected exchanges — the same universe the Bitcoin books trade.'
            : 'Dollar markets on the exchange your desk trades.'}
        </p>
        <BookSwitch value={book} onChange={changeBook} />
      </div>

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
      {!error && board?.error ? <ErrorNotice message={board.error} onRetry={() => scan()} /> : null}

      {loading && !board ? (
        <LoadingBlock label="Pulling candles for the strongest movers in the market" />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <p className="text-[11px] text-muted-foreground">
              {board?.exchangeFilter
                ? `${rows.length} of ${board?.scannedCount || 0} analysed setups shown · candidates drawn from the ${board.exchangeFilter.listed} ${isBtc ? 'BTC pairs' : 'pairs'} listed on ${board.exchangeFilter.label} (of ${board?.universeCount || 0} tradable markets)`
                : isBtc && board && !board.source?.exchange
                  ? `${rows.length} BTC-paired setups · connect an exchange that lists BTC markets to scan them`
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
            onSelect={(row) => navigate(`/coin/${row.symbol}${isBtc ? '?quote=BTC' : ''}`)}
            onWatch={toggleWatch}
            onBuy={isBtc ? null : (row) => setBuyRow(row)}
            watchSymbols={watchSymbols}
            targetPct={targetPct}
          />
          {!isBtc ? <ManualBuyDialog row={buyRow} defaultUsd={defaultBuyUsd} onClose={() => setBuyRow(null)} /> : null}
        </>
      )}
    </div>
  );
}