import React, { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import ConnectionsManager from '@/components/exchange/ConnectionsManager';
import ChangePassword from '@/components/settings/ChangePassword';

export default function Settings() {
  const [me, setMe] = useState(null);

  useEffect(() => {
    let alive = true;
    base44.auth
      .me()
      .then((u) => {
        if (alive) setMe(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const rows = me
    ? [
        ['Full name', me.full_name || '—'],
        ['Email', me.email || '—'],
        ['Role', me.role || '—'],
        ['Member since', me.created_date ? new Date(me.created_date).toLocaleDateString() : '—'],
      ]
    : [];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
      <header>
        <h1 className="font-heading text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Your account and your per-user exchange API keys.</p>
      </header>

      <div className="mt-5 grid gap-5">
        <div className="surface p-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/30">
              <UserRound className="h-4 w-4 text-primary" />
            </span>
            <h2 className="font-heading text-sm font-semibold">Your account</h2>
          </div>
          {me ? (
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              {rows.map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
                  <dt className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
                  <dd className="mt-1 truncate text-sm">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Loading account…</p>
          )}
        </div>

        <ChangePassword userId={me?.id} />

        <div>
          <h2 className="font-heading text-sm font-semibold">Exchange API keys</h2>
          <p className="text-sm text-muted-foreground">Each user manages their own venue connections — verified with a live account read before they are stored.</p>
          <div className="mt-4">
            <ConnectionsManager showSafety />
          </div>
        </div>
      </div>
    </div>
  );
}