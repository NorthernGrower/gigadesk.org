import React from 'react';

const GRADIENTS = [
  'from-emerald-400/90 to-teal-600/90',
  'from-sky-400/90 to-indigo-600/90',
  'from-amber-400/90 to-orange-600/90',
  'from-fuchsia-400/90 to-purple-600/90',
  'from-rose-400/90 to-red-600/90',
  'from-cyan-400/90 to-blue-600/90',
];

const SIZES = {
  sm: 'h-6 w-6 text-[9px]',
  md: 'h-8 w-8 text-[10px]',
  lg: 'h-12 w-12 text-sm',
};

function gradientFor(symbol) {
  let hash = 0;
  for (let i = 0; i < symbol.length; i += 1) {
    hash = (hash * 31 + symbol.charCodeAt(i)) % 9973;
  }
  return GRADIENTS[hash % GRADIENTS.length];
}

export default function CoinAvatar({ symbol = '', size = 'md', className = '' }) {
  const label = String(symbol || '?').slice(0, 3).toUpperCase();
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-display font-semibold tracking-wide text-white/95 ring-1 ring-white/10 ${
        SIZES[size] || SIZES.md
      } ${gradientFor(label)} ${className}`}
    >
      {label}
    </div>
  );
}