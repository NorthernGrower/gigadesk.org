import { base44 } from '@/api/base44Client';

export const TIMEFRAMES = [
  { value: '15m', label: '15m' },
  { value: '1h', label: '1H' },
  { value: '4h', label: '4H' },
  { value: '12h', label: '12H' },
  { value: '1d', label: '1D' },
  { value: '1w', label: '1W' },
  { value: '1M', label: '1M' },
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
  profit_mode: 'compound',
  sentiment_watch: true,
  real_orders_enabled: false,
  real_connection_id: '',
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
  const existing = pageItems(
    await base44.entities.BotConfig.filter({}, { sort: '-updated_date', limit: 1 }),
  );
  if (existing[0]) return existing[0];
  return await base44.entities.BotConfig.create(DEFAULT_CONFIG);
}

export async function scanMarket(payload = {}) {
  return unwrap(await base44.functions.invoke('scanMarket', payload));
}

export async function getCoinDetail(symbol, timeframe = '1h', withAi = false) {
  return unwrap(await base44.functions.invoke('coinDetail', { symbol, timeframe, withAi }));
}

// The bot cycle gets called from several places at once on page load (the
// desk, the header runner, a live trade change). Concurrent light calls share
// one result for a few seconds instead of each hitting the server — a burst
// of identical cycles was tripping the entity rate limit and returning 500s.
let lastLightRun = null;

// The last finished cycle's result, kept so revisiting pages render it
// instantly instead of staring at a spinner while a fresh scan runs. It also
// survives a fresh browser session through sessionStorage — a reload or a
// later visit renders the last scan straight away and refreshes quietly.
const LAST_BOT_KEY = 'gigadesk:lastBot';

const hydrateLastBot = () => {
  try {
    const raw = sessionStorage.getItem(LAST_BOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.data ? parsed : null;
  } catch {
    return null;
  }
};

let lastBot = hydrateLastBot();

const persistLastBot = () => {
  try {
    if (lastBot) sessionStorage.setItem(LAST_BOT_KEY, JSON.stringify(lastBot));
  } catch {
    // storage full or unavailable: the in-memory copy still covers revisits
  }
};

export function getLastBot(maxAgeMs = 600000) {
  return lastBot && Date.now() - lastBot.at < maxAgeMs ? lastBot.data : null;
}

function rememberBot(data) {
  if (!data) return;
  if (data.summary) {
    lastBot = { at: Date.now(), data };
    persistLastBot();
  } else if (lastBot) {
    // light cycles keep the scan's board but refresh the stats around it
    lastBot = {
      at: Date.now(),
      data: {
        ...lastBot.data,
        ...data,
        top: lastBot.data.top,
        summary: lastBot.data.summary,
        universe: lastBot.data.universe,
        median_change_24h: lastBot.data.median_change_24h,
        scanned: lastBot.data.scanned,
      },
    };
    persistLastBot();
  }
}

// A full cycle requested while one is already in flight shares its promise:
// overlapping full cycles used to race on the server, and the loser failed
// with a 500 — leaving that cycle with zero new trades.
let lastFullRun = null;

export function runBot(light = false) {
  // the desk's timezone keeps "today" counters on the user's own calendar day
  const invoke = async () => {
    const data = unwrap(await base44.functions.invoke('runBot', { light, tz_offset: new Date().getTimezoneOffset() }));
    rememberBot(data);
    return data;
  };
  if (!light) {
    if (lastFullRun && Date.now() - lastFullRun.at < 5000) return lastFullRun.promise;
    const promise = invoke().finally(() => {
      if (lastFullRun && lastFullRun.promise === promise) lastFullRun = null;
    });
    lastFullRun = { at: Date.now(), promise };
    return promise;
  }
  if (lastLightRun && Date.now() - lastLightRun.at < 10000) return lastLightRun.promise;
  lastLightRun = { at: Date.now(), promise: invoke() };
  return lastLightRun.promise;
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