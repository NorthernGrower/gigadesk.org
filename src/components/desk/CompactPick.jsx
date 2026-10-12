import React from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import CoinAvatar from '@/components/common/CoinAvatar';
import ScoreBadge from '@/components/common/ScoreBadge';
import { TIER_LABEL } from '@/lib/market';
import { fmtPrice } from '@/lib/format';

/** A compact desk pick card for ranked setups 2 and 3. */
export default function CompactPick({ row, rank, onOpenChart, onAnalyze }) {
  const isShort = row.side === 'short';
  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <CoinAvatar symbol={row.symbol} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="font-display text-sm font-semibold">{row.symbol}</p>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase ${
                  isShort ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
                }`}
              >
                {row.side}
              </span>
            </div>
            <p className="num mt-0.5 text-[11px] text-muted-foreground">
              #{rank} · {TIER_LABEL[row.market_cap_bucket] || 'Tier'}
            </p>
          </div>
        </div>
        <ScoreBadge verdict={row.verdict} score={row.score} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Entry</p>
          <p className="num mt-0.5 text-sm">{fmtPrice(row.entry)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Target</p>
          <p className="num mt-0.5 text-sm text-primary">{fmtPrice(row.target)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Stop</p>
          <p className="num mt-0.5 text-sm text-destructive">{fmtPrice(row.stop)}</p>
        </div>
      </div>

      {row.reasons?.[0] ? (
        <p className="mt-2.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{row.reasons[0]}</p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" onClick={onOpenChart}>
          Chart <ArrowRight className="ml-1.5 h-3 w-3" />
        </Button>
        <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" onClick={onAnalyze}>
          <Sparkles className="mr-1.5 h-3 w-3" /> AI read
        </Button>
      </div>
    </div>
  );
}