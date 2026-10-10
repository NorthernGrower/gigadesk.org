import React from 'react';
import { ExternalLink } from 'lucide-react';
import { fmtPct, fmtUsd } from '@/lib/format';

const shortWallet = (w) => (w ? `${w.slice(0, 6)}…${w.slice(-4)}` : '');

export default function TraderTable({ traders }) {
  return (
    <div className="surface overflow-hidden">
      <div className="border-b border-border/60 px-4 py-3">
        <p className="font-heading text-sm font-semibold">Top traders</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Ranked by profit on the selected window, among active accounts trading $1M+
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">Trader</th>
              <th className="px-4 py-2 text-right font-medium">Account</th>
              <th className="px-4 py-2 text-right font-medium">PnL</th>
              <th className="px-4 py-2 text-right font-medium">ROI</th>
              <th className="px-4 py-2 text-right font-medium">Open</th>
            </tr>
          </thead>
          <tbody>
            {(traders || []).map((t) => (
              <tr key={t.wallet} className="border-b border-border/40 last:border-0">
                <td className="num px-4 py-2.5 text-muted-foreground">{t.rank}</td>
                <td className="px-4 py-2.5">
                  <a
                    href={`https://app.hyperliquid.xyz/explorer/address/${t.wallet}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 hover:text-primary"
                  >
                    <span className="font-medium">{t.name || shortWallet(t.wallet)}</span>
                    {t.name ? <span className="num text-[10px] text-muted-foreground">{shortWallet(t.wallet)}</span> : null}
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </a>
                </td>
                <td className="num px-4 py-2.5 text-right">{fmtUsd(t.account_value_usd)}</td>
                <td className="num px-4 py-2.5 text-right text-primary">{fmtUsd(t.pnl_usd)}</td>
                <td className="num px-4 py-2.5 text-right">{fmtPct(t.roi_pct)}</td>
                <td className="num px-4 py-2.5 text-right text-muted-foreground">{t.open_positions ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}