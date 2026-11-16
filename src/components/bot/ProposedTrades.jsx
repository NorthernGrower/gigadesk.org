import React from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import CoinAvatar from '@/components/common/CoinAvatar';
import { EmptyState } from '@/components/common/States';
import { fmtPct, fmtPrice, fmtUsd } from '@/lib/format';

export default function ProposedTrades({ trades = [], onAction, busyId }) {
  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Waiting for your call</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            The bot sized each one from your risk rules. Approve to open it, skip to pass.
          </p>
        </div>
        <span className="num text-xs text-muted-foreground">{trades.length}</span>
      </div>

      {trades.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="Nothing waiting"
            description="When the bot finds a setup that clears your score and target bars, it lands here for approval."
          />
        </div>
      ) : (
        <div className="mt-3 space-y-2.5">
          {trades.map((trade) => (
            <div key={trade.id} className="rounded-xl border border-border/60 bg-secondary/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <CoinAvatar symbol={trade.symbol} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="font-display text-sm font-semibold">{trade.symbol}</p>
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase ${
                          trade.side === 'short' ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
                        }`}
                      >
                        {trade.side}
                      </span>
                      {trade.score ? <span className="num text-[11px] text-muted-foreground">score {trade.score}</span> : null}
                    </div>
                    <p className="num mt-0.5 text-[11px] text-muted-foreground">
                      {fmtUsd(trade.size_usd)} @ {fmtPrice(trade.entry_price)} ·{' '}
                      {trade.v3_algo ? 'no target (V3)' : `target ${fmtPrice(trade.target_price)}`} · stop{' '}
                      {fmtPrice(trade.stop_price)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAction('reject', trade.id)}
                    disabled={busyId === trade.id}
                  >
                    {busyId === trade.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="mr-1.5 h-3.5 w-3.5" />}
                    Skip
                  </Button>
                  <Button size="sm" onClick={() => onAction('approve', trade.id)} disabled={busyId === trade.id}>
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                    Approve
                  </Button>
                </div>
              </div>
              {trade.rationale ? (
                <p className="mt-2 border-t border-border/50 pt-2 text-[11px] leading-relaxed text-muted-foreground">
                  {trade.rationale}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}