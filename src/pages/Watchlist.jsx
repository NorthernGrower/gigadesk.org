import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Star, Trash2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import CoinAvatar from '@/components/common/CoinAvatar';
import ScoreBadge from '@/components/common/ScoreBadge';
import { EmptyState, ErrorNotice, LoadingBlock } from '@/components/common/States';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';
import { pageItems, scanMarket } from '@/lib/market';
import { fmtPct, fmtPrice } from '@/lib/format';

export default function Watchlist() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [items, setItems] = useState([]);
  const [rows, setRows] = useState([]);
  const [symbol, setSymbol] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const watch = pageItems(await base44.entities.Watchlist.filter({}, { sort: 'created_date', limit: 100 }));
      setItems(watch);
      if (watch.length) {
        const board = await scanMarket({
          symbols: watch.map((row) => row.symbol),
          count: 12,
          timeframe: '1h',
          scope: 'all',
        });
        const wanted = watch.map((row) => row.symbol);
        setRows((board.rows || []).filter((row) => wanted.includes(row.symbol)));
      } else {
        setRows([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const add = async () => {
    const value = symbol.trim().toUpperCase();
    if (!value) return;
    setBusy(true);
    try {
      const existing = pageItems(await base44.entities.Watchlist.filter({ symbol: value }, { limit: 1 }))[0];
      if (existing) {
        toast({ title: `${value} is already on your watchlist` });
      } else {
        await base44.entities.Watchlist.create({ symbol: value, name: value });
        setSymbol('');
        await refresh();
      }
    } catch (err) {
      toast({ title: 'Could not add that coin', description: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item) => {
    try {
      await base44.entities.Watchlist.delete(item.id);
      setItems((prev) => prev.filter((row) => row.id !== item.id));
      setRows((prev) => prev.filter((row) => row.symbol !== item.symbol));
    } catch (err) {
      toast({ title: 'Could not remove it', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-4">
      <div className="surface flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Your watchlist</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            These coins are always included in every scan, even when they are outside the top movers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            className="font-display w-40 uppercase"
            placeholder="Add symbol"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add();
            }}
          />
          <Button onClick={add} disabled={busy}>
            <Plus className="mr-2 h-4 w-4" /> Add
          </Button>
        </div>
      </div>

      {error ? <ErrorNotice message={error} onRetry={refresh} /> : null}

      {loading ? (
        <LoadingBlock label="Checking your coins against the market" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Star}
          title="Nothing on the watchlist yet"
          description="Add the coins you actually trade — the screener star button adds them too. Every scan analyses your list no matter how the market is moving."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const row = rows.find((entry) => entry.symbol === item.symbol);
            return (
              <div key={item.id} className="surface flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2.5 text-left"
                    onClick={() => navigate(`/coin/${item.symbol}`)}
                  >
                    <CoinAvatar symbol={item.symbol} size="lg" />
                    <div className="min-w-0">
                      <p className="font-display text-sm font-semibold">{item.symbol}</p>
                      {row ? (
                        <p className="num mt-0.5 text-[11px] text-muted-foreground">
                          {fmtPrice(row.price)} ·{' '}
                          <span className={row.change24h >= 0 ? 'text-primary' : 'text-destructive'}>
                            {fmtPct(row.change24h)}
                          </span>
                        </p>
                      ) : (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">No live pair for this coin</p>
                      )}
                    </div>
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => remove(item)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {row ? (
                  <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                    <ScoreBadge verdict={row.verdict} score={row.score} />
                    <button
                      type="button"
                      className="num text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      onClick={() => navigate(`/coin/${item.symbol}`)}
                    >
                      target {fmtPrice(row.target)}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}