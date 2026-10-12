import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Radar } from 'lucide-react';
import CoinAvatar from '@/components/common/CoinAvatar';
import ScoreBadge from '@/components/common/ScoreBadge';
import { TIER_LABEL } from '@/lib/market';
import { fmtPrice } from '@/lib/format';

/**
 * The desk's scanned list: the coins the last full scan ranked. The desk runs a
 * full scan each time the page is opened, so this list is fresh on entry.
 */
export default function ScannedCoins({ rows = [], scannedCount }) {
  const navigate = useNavigate();
  const coins = (rows || []).slice(0, 12);

  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          <Radar className="h-3.5 w-3.5" /> Scanned coins
        </p>
        <span className="num text-[11px] text-muted-foreground">
          {coins.length ? `${coins.length} ranked` : '—'}
          {scannedCount ? ` of ${scannedCount} analysed` : ''}
        </span>
      </div>

      {coins.length === 0 ? (
        <p className="mt-3 text-[12px] text-muted-foreground">
          No scan results yet — the list refreshes every time you open the desk.
        </p>
      ) : (
        <div className="mt-3 space-y-1.5">
          {coins.map((row) => (
            <button
              key={`${row.symbol}-${row.side}`}
              type="button"
              onClick={() => navigate(`/coin/${row.symbol}`)}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/50 bg-secondary/20 px-3 py-2 text-left transition-colors hover:border-primary/40"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <CoinAvatar symbol={row.symbol} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="font-display text-sm font-semibold">{row.symbol}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase ${
                        row.side === 'short' ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
                      }`}
                    >
                      {row.side}
                    </span>
                  </span>
                  <span className="num block text-[11px] text-muted-foreground">
                    {TIER_LABEL[row.market_cap_bucket] || 'Tier'} · entry {fmtPrice(row.entry)}
                  </span>
                </span>
              </span>
              <ScoreBadge verdict={row.verdict} score={row.score} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}