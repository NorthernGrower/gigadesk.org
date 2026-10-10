import React from 'react';
import ConnectionsManager from '@/components/exchange/ConnectionsManager';

export default function Exchanges() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Exchanges</h1>
          <p className="text-sm text-muted-foreground">
            Connect a venue&apos;s API key so the desk can read balances — and, once execution is wired, place the bot&apos;s orders.
          </p>
        </div>
      </header>
      <div className="mt-5">
        <ConnectionsManager showSafety />
      </div>
    </div>
  );
}