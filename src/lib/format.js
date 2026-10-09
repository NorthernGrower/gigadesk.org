import { format, formatDistanceToNowStrict, parseISO } from 'date-fns';

export function fmtPrice(v) {
  const n = Number(v) || 0;
  if (!n) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 10) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(3);
  if (abs >= 0.01) return n.toFixed(5);
  if (abs >= 0.0001) return n.toFixed(6);
  return n.toFixed(8);
}

export function fmtUsd(v, digits = 2) {
  const n = Number(v) || 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtCompactUsd(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function fmtPct(v, digits = 2) {
  const n = Number(v) || 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function toneOf(v) {
  const n = Number(v) || 0;
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}

export function toneClass(v) {
  const t = toneOf(v);
  if (t === 'up') return 'text-primary';
  if (t === 'down') return 'text-destructive';
  return 'text-muted-foreground';
}

export function timeAgo(iso) {
  try {
    return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

export function fmtDate(iso) {
  try {
    return format(parseISO(iso), 'MMM d, HH:mm');
  } catch {
    return '—';
  }
}

export function fmtDay(iso) {
  try {
    return format(parseISO(iso), 'MMM d');
  } catch {
    return '';
  }
}

export function fmtClock(iso) {
  try {
    return format(parseISO(iso), 'HH:mm');
  } catch {
    return '';
  }
}