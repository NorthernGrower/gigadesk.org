import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import CoinAvatar from '@/components/common/CoinAvatar';
import CloseAllButton from '@/components/dashboard/CloseAllButton';
import { EmptyState } from '@/components/common/States';
import { fmtPct, fmtPrice, fmtUsd } from '@/lib/format';

export default function PositionsPanel({
  positions = [],
  onClose,
  onCloseAll,
  closingId,
  closingAll = false,
  title = 'Open positions',
  hint,
}) {
  const navigate = useNavigate();

  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
          {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {onCloseAll && positions.length > 0 ? (
            <CloseAllButton count={positions.length} busy={closingAll} onConfirm={onCloseAll} />
          ) : null}
          <span className="num text-xs text-muted-foreground">{positions.length}</span>
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="Nothing open"
            description="Positions the bot opens — or the ones you take from a chart — show up here with live profit and loss."
          />
        </div>
      ) : (
        <div className="mt-3 space-y-2.5">
          {positions.map((p) => {
            const isShort = p.side === 'short';
            const Icon = isShort ? ArrowDownRight : ArrowUpRight;
            return (
              <div
                key={p.id || p.symbol}
                className={`rounded-xl border border-border/60 bg-secondary/20 p-3 ${p.id ? 'cursor-pointer transition-colors hover:border-primary/40' : ''}`}
                onClick={p.id ? () => navigate(`/trade/${p.id}`) : undefined}
                title={p.id ? 'Open the call card' : undefined}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <CoinAvatar symbol={p.symbol} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="font-display text-sm font-semibold">{p.symbol}</p>
                        <span
                          className={`flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] uppercase ${
                            isShort ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
                          }`}
                        >
                          <Icon className="h-3 w-3" />
                          {p.side}
                        </span>
                      </div>
                      <p className="num mt-0.5 text-[11px] text-muted-foreground">
                        {fmtPrice(p.entry_price)} → {fmtPrice(p.current_price)} · {fmtUsd(p.size_usd)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className={`num text-sm font-medium ${p.pnl_usd >= 0 ? 'text-primary' : 'text-destructive'}`}>
                        {fmtUsd(p.pnl_usd)}
                      </p>
                      <p className={`num text-[11px] ${p.pnl_usd >= 0 ? 'text-primary' : 'text-destructive'}`}>
                        {fmtPct(p.pnl_pct)}
                      </p>
                    </div>
                    {onClose ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 px-2 text-[11px] hover:border-destructive/60 hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); onClose(p); }}
                        disabled={closingId === p.id || closingAll}
                        title={`Close ${p.symbol} at the live price`}
                      >
                        {closingId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                        Close
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="mt-2.5 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/60">
                    <div
                      className={`h-full rounded-full ${p.pnl_usd >= 0 ? 'bg-primary' : 'bg-destructive'}`}
                      style={{ width: `${Math.max(0, Math.min(100, p.progress_pct || 0))}%` }}
                    />
                  </div>
                  <span className="num text-[10px] text-muted-foreground">
                    stop {fmtPrice(p.stop_price)} · target {fmtPrice(p.target_price)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}