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

/**
 * The server's own message out of a failed function call. The SDK throws a bare
 * "status code 500" (or 502) and the reason — which coin could not be priced, or
 * which stage stopped the cycle — is only in the response body. A body that is
 * not JSON (a platform timeout page, a gateway error) carries no `error` field,
 * so its text is used instead, flattened and capped.
 */
function serverError(err) {
  const body = (err && err.response && (err.response.data || err.response.body)) || null;
  const plain =
    typeof body === 'string' ? body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const detail =
    (body && typeof body === 'object' && (body.error || body.detail || body.message)) ||
    (plain ? plain.slice(0, 300) : null) ||
    (err && err.data && err.data.error) ||
    null;
  return detail ? String(detail) : null;
}

export async function ensureBotConfig() {
  const existing = pageItems(
    await base44.entities.BotConfig.filter({}, { sort: '-updated_date', limit: 1 }),
  );
  if (existing[0]) return existing[0];
  return await base44.entities.BotConfig.create(DEFAULT_CONFIG);
}

// The market-wide scan behind the desk pulse, the screener and the watchlist
// takes the server tens of seconds — and each page fired its own on mount, so
// two or three identical scans stacked up in parallel and starved the app's
// data reads. Identical scans within a minute share one request or its fresh
// result instead of running side by side.
let lastScan = null;

export function scanMarket(payload = {}) {
  const key = JSON.stringify(payload);
  if (lastScan && lastScan.key === key && Date.now() - lastScan.at < 60000) return lastScan.promise;
  const promise = base44.functions.invoke('scanMarket', payload).then(unwrap);
  lastScan = { at: Date.now(), key, promise };
  promise.catch(() => {
    if (lastScan && lastScan.promise === promise) lastScan = null;
  });
  return promise;
}

export async function getCoinDetail(symbol, timeframe = '1h', withAi = false) {
  try {
    return unwrap(await base44.functions.invoke('coinDetail', { symbol, timeframe, withAi }));
  } catch (err) {
    // the SDK's own HTTP message ("Request failed with status code 404")
    // hides the function's reason — surface the body's error when it travels
    const reason = err?.response?.data?.error || err?.data?.error;
    throw new Error(reason || err.message || 'Could not load the coin.');
  }
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

/** How old the board is, so pages can skip a scan that would only repeat it. */
export function lastBotAgeMs() {
  return lastBot ? Date.now() - lastBot.at : Number.POSITIVE_INFINITY;
}

// The market pulse keeps its own cache: it re-renders on revisits and reloads
// instead of rescanning the whole market every time the desk mounts.
const LAST_PULSE_KEY = 'gigadesk:lastPulse';

const hydrateLastPulse = () => {
  try {
    const raw = sessionStorage.getItem(LAST_PULSE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.data ? parsed : null;
  } catch {
    return null;
  }
};

let lastPulse = hydrateLastPulse();

const persistLastPulse = () => {
  try {
    if (lastPulse) sessionStorage.setItem(LAST_PULSE_KEY, JSON.stringify(lastPulse));
  } catch {
    // storage unavailable: the in-memory copy still covers revisits
  }
};

export function getLastPulse(maxAgeMs = 15 * 60 * 1000) {
  return lastPulse && Date.now() - lastPulse.at < maxAgeMs ? lastPulse.data : null;
}

export function rememberPulse(pulse) {
  if (!pulse) return;
  lastPulse = { at: Date.now(), data: pulse };
  persistLastPulse();
}

function rememberBot(data) {
  if (!data) return;
  if (data.summary) {
    lastBot = { at: Date.now(), data };
    persistLastBot();
  } else if (lastBot) {
    // light cycles keep the scan's board but refresh the stats around it —
    // and keep the board's own timestamp, so its age still tracks the last
    // full scan and stale boards still relaunch one
    lastBot = {
      at: lastBot.at,
      data: {
        ...lastBot.data,
        ...data,
        top: lastBot.data.top,
        summary: lastBot.data.summary,
        universe: lastBot.data.universe,
        median_change_24h: lastBot.data.median_change_24h,
        scanned: lastBot.data.scanned,
        // the Bitcoin board is a scan too: a light cycle carries none, and
        // dropping it blanked the Bitcoin book's picks and its scanned count
        // on every quiet refresh
        btc_markets: withPreviousBoard(data.btc_markets, lastBot.data.btc_markets),
      },
    };
    persistLastBot();
  }
}

// A scan board is only replaced by a newer scan: a cycle that did not scan
// (a light pass, an off cycle, a board that failed) must pass the last one
// through, exactly as the dollar board's rows and summary are passed through.
export function withPreviousBoard(next, prev) {
  if (!next) return prev;
  const board = next.board && ((next.board.scanned || 0) > 0 || (next.board.top || []).length)
    ? next.board
    : prev?.board || next.board;
  return { ...next, board };
}

// A full cycle requested while one is already in flight shares its promise:
// overlapping full cycles used to race on the server, and the loser failed
// with a 500 — leaving that cycle with zero new trades.
let lastFullRun = null;

export function runBot(light = false) {
  // the desk's timezone keeps "today" counters on the user's own calendar day
  // the SDK throws a bare "status code 500" when the function fails, so the
  // server's own message is lifted out of the response body for the page
  const invoke = async () => {
    try {
      const data = unwrap(
        await base44.functions.invoke('runBot', {
          light,
          tz_offset: new Date().getTimezoneOffset(),
        }),
      );
      rememberBot(data);
      return data;
    } catch (err) {
      const detail = serverError(err);
      if (detail) throw new Error(detail);
      throw err;
    }
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
  try {
    return unwrap(await base44.functions.invoke('tradeAction', { action, trade_id: tradeId }));
  } catch (err) {
    // a refused close answers 502 with the reason — which coin could not be
    // priced — and the SDK's bare "status code 502" would hide it
    const detail = serverError(err);
    if (detail) throw new Error(detail);
    throw err;
  }
}

/** The desk analyst's read on one desk. Read-only commentary: it returns a note
 *  and the numbers behind it, and it never places, sizes or changes a trade.
 *  One note is stored per desk per day, so asking on every visit is cheap. */
export async function deskAnalyst(desk = 'paper', force = false) {
  try {
    return unwrap(await base44.functions.invoke('deskAnalyst', { desk, force }));
  } catch (err) {
    const reason = err?.response?.data?.error || err?.data?.error;
    throw new Error(reason || err.message || 'Could not load the desk analyst.');
  }
}

/** A manual buy from the scanner: a real market order, opened in manual mode. */
export async function manualBuy({ symbol, usd }) {
  return unwrap(await base44.functions.invoke('manualBuy', { symbol, usd }));
}

/** Broadcasts a finished bot cycle to every page listening. */
export function emitBotTick(data) {
  window.dispatchEvent(new CustomEvent('bot:tick', { detail: data }));
}

export function requestBotRun() {
  window.dispatchEvent(new CustomEvent('bot:run'));
}