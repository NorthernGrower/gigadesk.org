import { base44 } from '@/api/base44Client';

export const TIMEFRAMES = [
  { value: '15m', label: '15m' },
  { value: '1h', label: '1H' },
  { value: '4h', label: '4H' },
  { value: '1d', label: '1D' },
];

export const TIERS = [
  { value: 'all', label: 'All tiers' },
  { value: 'large', label: 'Major' },
  { value: 'mid', label: 'Mid' },
  { value: 'small', label: 'Small + micro' },
];

export const TIER_LABEL = {
  large: 'Major',
  mid: 'Mid',
  small: 'Small',
  micro: 'Micro',
};

export const VERDICT_LABEL = {
  strong_long: 'Strong long',
  long: 'Long',
  watch: 'Watch',
  short: 'Short',
  strong_short: 'Strong short',
  avoid: 'Avoid',
};

export const MODE_LABEL = {
  off: 'Signals only',
  approve: 'Approve each trade',
  auto: 'Fully automatic',
};

export const MODE_HINT = {
  off: 'The bot finds setups and leaves the decisions to you.',
  approve: 'The bot proposes each trade with its levels — you approve or skip it.',
  auto: 'The bot opens and closes positions on its own using your risk rules.',
};

export const DEFAULT_CONFIG = {
  mode: 'approve',
  starting_balance: 10000,
  cash_balance: 10000,
  risk_per_trade_pct: 4,
  max_open_positions: 8,
  default_stop_pct: 2.5,
  target_pct: 2,
  daily_target_pct: 2,
  trailing_stop: true,
  trailing_trigger_pct: 1,
  trailing_distance_pct: 1.5,
  allow_shorts: true,
  timeframe: '1h',
  market_cap_scope: 'all',
  min_score: 62,
  require_daily_target: true,
  cooldown_minutes: 120,
  auto_run: true,
};

export function roundTo(n, d = 2) {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
}

export const round2 = (n) => roundTo(n, 2);

export function pageItems(res) {
  if (Array.isArray(res)) return res;
  return (res && res.items) || [];
}

function unwrap(res) {
  const data = res && res.data ? res.data : res;
  if (data && data.error) throw new Error(data.error);
  return data;
}

export async function ensureBotConfig() {
  const existing = pageItems(await base44.entities.BotConfig.filter({}, { limit: 1 }));
  if (existing[0]) return existing[0];
  return await base44.entities.BotConfig.create(DEFAULT_CONFIG);
}

export async function scanMarket(payload = {}) {
  return unwrap(await base44.functions.invoke('scanMarket', payload));
}

export async function getCoinDetail(symbol, timeframe = '1h', withAi = false) {
  return unwrap(await base44.functions.invoke('coinDetail', { symbol, timeframe, withAi }));
}

export async function runBot(light = false) {
  return unwrap(await base44.functions.invoke('runBot', { light }));
}

/** `tradeId` is optional: the `close_all` action works without one. */
export async function tradeAction(action, tradeId = '') {
  return unwrap(await base44.functions.invoke('tradeAction', { action, trade_id: tradeId }));
}

/** Broadcasts a finished bot cycle to every page listening. */
export function emitBotTick(data) {
  window.dispatchEvent(new CustomEvent('bot:tick', { detail: data }));
}

export function requestBotRun() {
  window.dispatchEvent(new CustomEvent('bot:run'));
}