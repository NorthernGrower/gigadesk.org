import React, { useState } from 'react';
import { CheckCircle2, KeyRound, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EXCHANGE_META } from './meta';

const fmt = (n) => {
  const v = Number(n) || 0;
  return v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toLocaleString(undefined, { maximumFractionDigits: 6 });
};

export default function ConnectionCard({ conn, busy, onCheck, onRemove, onConvert }) {
  const [confirming, setConfirming] = useState(false);
  const [confirmConvert, setConfirmConvert] = useState(false);
  const meta = EXCHANGE_META[conn.exchange] || { name: conn.exchange };
  const ok = conn.status === 'connected';
  const balances = Array.isArray(conn.balances) ? conn.balances.slice(0, 5) : [];
  // cash held in a currency the bot cannot trade with — Kraken has no
  // fiat-to-fiat route, so it buys USD on the USD/fiat market
  const fiat = (conn.balances || []).find((b) => ['CAD', 'EUR', 'GBP'].includes(b.asset) && (Number(b.total) || 0) >= 1);

  return (
    <div className="surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/30">
            <KeyRound className="h-4 w-4 text-primary" />
          </span>
          <div>
            <p className="font-heading text-sm font-semibold">
              {conn.label || meta.name}
              {conn.testnet && (
                <span className="ml-2 rounded-md border border-accent/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent">
                  testnet
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {meta.name} · key {conn.key_hint || '••••'}
            </p>
          </div>
        </div>
        <span
          className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium ${
            ok ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'
          }`}
        >
          {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {ok ? 'Connected' : 'Error'}
        </span>
      </div>

      {conn.status_message && (
        <p className={`mt-3 text-xs leading-relaxed ${ok ? 'text-muted-foreground' : 'text-destructive/90'}`}>{conn.status_message}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
        <span className={`rounded-md border px-2 py-1 ${conn.allow_trading ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground'}`}>
          {conn.allow_trading ? 'Live trading enabled' : 'Trading disabled'}
        </span>
        {balances.length > 0 && (
          <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">{conn.balances.length} assets held</span>
        )}
      </div>

      {balances.length > 0 && (
        <div className="mt-3 grid gap-1 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
          {balances.map((b) => (
            <div key={b.asset} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{b.asset}</span>
              <span className="num">{fmt(b.total)}</span>
            </div>
          ))}
          {conn.balances.length > balances.length && (
            <p className="text-[11px] text-muted-foreground">+ {conn.balances.length - balances.length} more</p>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          {conn.last_checked_at ? `Checked ${new Date(conn.last_checked_at).toLocaleString()}` : 'Never checked'}
        </p>
        <div className="flex items-center gap-2">
          {fiat && onConvert && (
            confirmConvert ? (
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => onConvert(conn)}>
                Confirm convert
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmConvert(true)} title="Buys USD with this cash on the USD market so the bot can trade it">
                Convert {fiat.asset} to USD
              </Button>
            )
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onCheck(conn)}>
            <RefreshCw className={busy ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            Check
          </Button>
          {confirming ? (
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => onRemove(conn)}>
              Confirm remove
            </Button>
          ) : (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}