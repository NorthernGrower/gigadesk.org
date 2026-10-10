import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, Trash2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import CoinAvatar from '@/components/common/CoinAvatar';
import { EmptyState } from '@/components/common/States';
import { useToast } from '@/components/ui/use-toast';
import { roundTo } from '@/lib/market';
import { fmtDate, fmtPct, fmtPrice, fmtUsd } from '@/lib/format';

const STATUS_TONES = {
  open: 'bg-accent/15 text-accent',
  proposed: 'bg-amber-400/15 text-amber-300',
  closed: 'bg-secondary text-muted-foreground',
  rejected: 'bg-secondary text-muted-foreground line-through',
};

export default function TradeTable({ trades = [], onChanged, showMode = true }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [closingId, setClosingId] = useState(null);
  const [exitPrice, setExitPrice] = useState('');
  const [busyId, setBusyId] = useState(null);

  const closeTrade = async (trade) => {
    const exit = Number(exitPrice);
    if (!(exit > 0)) {
      toast({ title: 'Enter the exit price', variant: 'destructive' });
      return;
    }
    setBusyId(trade.id);
    try {
      const pnl =
        trade.side === 'short'
          ? (Number(trade.entry_price) - exit) * Number(trade.quantity)
          : (exit - Number(trade.entry_price)) * Number(trade.quantity);
      const pnlPct = trade.size_usd ? (pnl / Number(trade.size_usd)) * 100 : 0;
      await base44.entities.Trade.update(trade.id, {
        status: 'closed',
        exit_price: roundTo(exit, 6),
        pnl_usd: roundTo(pnl, 2),
        pnl_pct: roundTo(pnlPct, 2),
        closed_at: new Date().toISOString(),
        exit_reason: 'manual',
      });
      toast({ title: `${trade.symbol} closed`, description: `${fmtUsd(pnl)} on ${fmtUsd(trade.size_usd)}.` });
      setClosingId(null);
      setExitPrice('');
      if (onChanged) onChanged();
    } catch (error) {
      toast({ title: 'Could not close the trade', description: error.message, variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (trade) => {
    setBusyId(trade.id);
    try {
      await base44.entities.Trade.delete(trade.id);
      toast({ title: `${trade.symbol} entry removed` });
      if (onChanged) onChanged();
    } catch (error) {
      toast({ title: 'Could not remove the entry', description: error.message, variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  if (!trades.length) {
    return (
      <EmptyState
        title="No trades yet"
        description="Paper positions the bot opens and the real fills you log both land in this journal."
      />
    );
  }

  return (
    <div className="space-y-2.5">
      {trades.map((trade) => {
        const open = trade.status === 'open';
        const isClosing = closingId === trade.id;
        return (
          <div
            key={trade.id}
            className="surface cursor-pointer p-3 transition-colors hover:border-primary/40"
            onClick={() => navigate(`/trade/${trade.id}`)}
            title="Open the call card"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <CoinAvatar symbol={trade.symbol} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-display text-sm font-semibold">{trade.symbol}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase ${
                        trade.side === 'short' ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
                      }`}
                    >
                      {trade.side}
                    </span>
                    {showMode ? (
                      <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                        {trade.mode === 'real' ? 'real money' : 'paper'}
                      </span>
                    ) : null}
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase ${STATUS_TONES[trade.status] || ''}`}>
                      {trade.status}
                      {trade.exit_reason ? ` · ${trade.exit_reason}` : ''}
                    </span>
                  </div>
                  <p className="num mt-0.5 text-[11px] text-muted-foreground">
                    {fmtUsd(trade.size_usd)} · {fmtPrice(trade.entry_price)}
                    {trade.exit_price ? ` → ${fmtPrice(trade.exit_price)}` : ''} · {fmtDate(trade.opened_at || trade.created_date)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {trade.status === 'closed' ? (
                  <div className="text-right">
                    <p className={`num text-sm font-medium ${(trade.pnl_usd || 0) >= 0 ? 'text-primary' : 'text-destructive'}`}>
                      {fmtUsd(trade.pnl_usd || 0)}
                    </p>
                    <p className={`num text-[11px] ${(trade.pnl_usd || 0) >= 0 ? 'text-primary' : 'text-destructive'}`}>
                      {fmtPct(trade.pnl_pct || 0)}
                    </p>
                  </div>
                ) : (
                  <span className="num text-[11px] text-muted-foreground">
                    stop {trade.stop_price ? fmtPrice(trade.stop_price) : '—'}
                  </span>
                )}

                {open && trade.mode === 'real' && !isClosing ? (
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={(e) => { e.stopPropagation(); setClosingId(trade.id); }}>
                    Close
                  </Button>
                ) : null}

                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); remove(trade); }}
                  disabled={busyId === trade.id}
                  title="Remove this entry"
                >
                  {busyId === trade.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>

            {isClosing ? (
              <div className="mt-2.5 flex items-end gap-2 border-t border-border/60 pt-2.5" onClick={(e) => e.stopPropagation()}>
                <Input
                  className="num h-8 max-w-[160px]"
                  inputMode="decimal"
                  placeholder="Exit price"
                  value={exitPrice}
                  onChange={(event) => setExitPrice(event.target.value)}
                />
                <Button size="sm" className="h-8" onClick={() => closeTrade(trade)} disabled={busyId === trade.id}>
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  Confirm
                </Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={() => setClosingId(null)}>
                  Cancel
                </Button>
              </div>
            ) : null}

            {trade.notes ? (
              <p className="mt-2 border-t border-border/50 pt-2 text-[11px] leading-relaxed text-muted-foreground">
                {trade.notes}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}