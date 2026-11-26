import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { fmtUsd } from '@/lib/format';

/**
 * The desk's most recent closes, so both desks end with the same list. `mode`
 * picks the book — "real" on the live desk, "paper" on the paper one — and the
 * exchange details only appear where there is an exchange behind the trade.
 */
export default function RecentCloses({ mode = 'paper', limit = 6, quote = 'USD' }) {
  const [rows, setRows] = useState([]);
  const book = quote === 'BTC' ? 'BTC' : 'USD';

  useEffect(() => {
    let alive = true;
    base44.entities.Trade.filter({ mode, status: 'closed' }, { sort: '-closed_at', limit: limit * 3 })
      .then((page) => {
        if (!alive) return;
        const items = Array.isArray(page) ? page : page?.items || [];
        // only this book's closes: the two books share a journal but never a page
        setRows(
          items
            .filter((t) => (t.quote_asset === 'BTC' ? 'BTC' : 'USD') === book)
            .slice(0, limit),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mode, limit, book]);

  if (!rows.length) return null;

  return (
    <div className="surface p-4">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        Recent closed {mode === 'real' ? 'live' : 'paper'} {book === 'BTC' ? 'Bitcoin' : 'dollar'} trades
      </p>
      <div className="mt-2 space-y-1.5">
        {rows.map((t) => (
          <div key={t.id} className="flex items-center justify-between gap-3 text-[12px]">
            <span className="flex items-center gap-2">
              <span className="font-semibold">{t.symbol}</span>
              <span className="num text-[11px] text-muted-foreground">
                {t.exchange ? `${t.exchange} · ` : ''}
                {mode === 'real'
                  ? t.exchange_order_id
                    ? `order ${String(t.exchange_order_id).slice(0, 10)}…`
                    : 'logged by hand'
                  : t.exit_reason
                    ? String(t.exit_reason).replace('_', ' ')
                    : 'closed'}
              </span>
            </span>
            <span className={`num ${Number(t.pnl_usd) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {fmtUsd(t.pnl_usd)} ({t.pnl_pct ?? 0}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
