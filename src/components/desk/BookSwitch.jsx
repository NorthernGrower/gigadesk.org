import React from 'react';

// The book a desk is showing: its dollar market or its Bitcoin market. They are
// two separate books — their own bankroll, positions, cooldowns, stats and scan —
// so this switch changes every figure on the page, never a filter over one set of
// numbers. Persisted with the desk so a reload comes back to the same book.
export const BOOKS = [
  { value: 'USD', label: 'USD' },
  { value: 'BTC', label: 'BTC' },
];

export default function BookSwitch({ value, onChange }) {
  const current = value === 'BTC' ? 'BTC' : 'USD';
  return (
    <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-secondary/40 p-0.5">
      {BOOKS.map((book) => (
        <button
          key={book.value}
          type="button"
          onClick={() => onChange(book.value)}
          title={
            book.value === 'BTC'
              ? 'Bitcoin markets: every figure here is the Bitcoin book'
              : 'Dollar markets: every figure here is the dollar book'
          }
          className={`rounded-lg px-3 py-1.5 text-[11px] transition-colors ${
            current === book.value
              ? book.value === 'BTC'
                ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/30'
                : 'bg-primary/15 text-primary ring-1 ring-primary/30'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {book.label}
        </button>
      ))}
    </div>
  );
}
