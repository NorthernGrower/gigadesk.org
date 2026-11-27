// A book keeps its own trade rules. The engine and the trade logic are shared;
// only the saved values differ. A book with no saved set yet reads the current
// dollar rules, because the first cycle seeds its set from them.
const USD_KEYS = [
  'profit_mode', 'score_bar', 'risk_per_trade_pct', 'max_open_positions', 'daily_target_pct',
  'cooldown_minutes', 'trailing_stop', 'trailing_trigger_pct', 'trailing_distance_pct',
  'allow_shorts', 'trading_style', 'timeframe', 'market_cap_scope', 'sentiment_watch',
  'confluence_v2', 'engine_v2', 'champion_engine', 'btc_gate', 'max_trade_loss_pct',
  'pyramid', 'pyramid_trigger_pct', 'v3_algo', 'v3_exit', 'harmonics', 'always_take_top',
  'always_take_count', 'analyst_on',
];

const LIVE_KEYS = [
  ...USD_KEYS.filter((key) => key !== 'allow_shorts'),
  // the share of the account's Bitcoin the live Bitcoin book may deploy, and
  // the hard ceiling it must stay under
  'btc_use_pct', 'btc_cap_btc',
  'profit_lock', 'lock_arm_pct', 'giveback_pct', 'margin_engine', 'margin_leverage', 'btc_markets',
];

const BOOK_KEYS = {
  paper: { USD: USD_KEYS, BTC: [...USD_KEYS, 'profit_mode', 'starting_balance'] },
  live: { USD: LIVE_KEYS, BTC: LIVE_KEYS },
};

export function bookRuleSet(config, desk, book) {
  if (desk === 'live') {
    const lr = config?.live_rules || {};
    return book === 'BTC' ? { ...lr, ...(lr.live_btc_rules || {}) } : lr;
  }
  return book === 'BTC' ? { ...config, ...(config?.btc_rules || {}) } : config || {};
}

export function bookRuleKeys(desk, book) {
  return BOOK_KEYS[desk === 'live' ? 'live' : 'paper'][book === 'BTC' ? 'BTC' : 'USD'];
}
