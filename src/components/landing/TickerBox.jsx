import React from 'react';

const usd = (n) =>
  '$' + Math.round(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

function buildItems(s) {
  return [
    { label: 'GIGADESK DESK EQUITY', value: usd(s.equity), tone: 'up' },
    { label: 'LIFETIME RETURN', value: `${s.growth_pct >= 0 ? '+' : ''}${s.growth_pct}%`, tone: s.growth_pct >= 0 ? 'up' : 'down' },
    { label: "TODAY'S P&L", value: `${s.today_pnl >= 0 ? '+' : ''}${usd(s.today_pnl)}`, tone: s.today_pnl >= 0 ? 'up' : 'down' },
    { label: 'WIN RATE', value: `${s.win_rate}%`, tone: s.win_rate >= 50 ? 'up' : 'down' },
    { label: 'CLOSED TRADES', value: String(s.closed_count), tone: 'flat' },
    { label: 'OPEN POSITIONS', value: String(s.open_count), tone: 'flat' },
    { label: 'BEST TRADE', value: `+${usd(s.best_trade)}`, tone: 'up' },
    { label: 'DESK STATUS', value: 'NEVER SLEEPS', tone: 'up' },
  ];
}

function Strip({ items }) {
  return (
    <div className="flex w-max items-center gap-6 px-3 py-2.5">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-6">
          <span className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="font-display text-[10px] tracking-[0.14em] text-muted-foreground">
              {it.label}
            </span>
            <span
              className={`num text-sm font-semibold ${
                it.tone === 'up' ? 'text-primary' : it.tone === 'down' ? 'text-destructive' : 'text-foreground'
              }`}
            >
              {it.value}
            </span>
          </span>
          <span className="text-primary/40">◆</span>
        </span>
      ))}
    </div>
  );
}

export default function TickerBox({ stats }) {
  const items = buildItems(stats);
  return (
    <div className="relative overflow-hidden rounded-xl border border-primary/25 bg-card/80 shadow-[0_0_40px_-12px_rgba(19,216,144,0.35)]">
      <div className="flex w-max animate-marquee">
        <Strip items={items} />
        <Strip items={items} />
      </div>
    </div>
  );
}