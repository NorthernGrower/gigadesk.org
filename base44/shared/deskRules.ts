// Desk separation: every live rule stands on its own. When a live rule was
// never saved it falls back to the live default below — never to a paper
// (config-level) value — so changing the paper desk can never move the live
// desk, and the other way around.
export const LIVE_DEFAULTS = {
  real_connection_id: "",
  live_cap_usd: 0,
  score_bar: 70,
  risk_per_trade_pct: 4,
  max_open_positions: 8,
  daily_target_pct: 2,
  cooldown_minutes: 120,
  default_stop_pct: 2.5,
  target_pct: 2,
  allow_shorts: true,
  min_score: 62,
  require_daily_target: true,
  trailing_stop: true,
  trailing_trigger_pct: 3,
  trailing_distance_pct: 1.5,
  trading_style: "mild",
  timeframe: "1h",
  market_cap_scope: "all",
  sentiment_watch: true,
  confluence_v2: true,
  engine_v2: true,
  champion_engine: true,
  btc_gate: true,
  combo_engine: true,
  margin_engine: false,
  margin_leverage: 2,
  v3_algo: false,
  v3_profile: "loose",
  // the measured exit on this desk's own entries: 2xATR stop, no target and a
  // 30-bar horizon, from the exit study (+7.18% / +7.76% / +1.62% per trade
  // out of sample against the fixed target's +1.35% / +2.40% / -0.48%)
  v3_exit: false,
  btc_gate_mode: "any",
  always_take_top: false,
  always_take_count: 5,
  // BTC-quoted markets: a second, fully separate book on the desk. Each desk
  // switches them on for itself. The live book sizes from the account's own
  // Bitcoin spot balance and takes longs only, so switching this on can never
  // spend dollar cash and can never open a margin short on a Bitcoin market.
  // Its cash, slots, cooldowns, brakes and lessons are its own: nothing on the
  // dollar side can starve it or be starved by it.
  btc_markets: false,
  // read-only commentary. It reaches no order path, and a desk with it off
  // makes no analyst call at all rather than calling and discarding the answer
  analyst_on: false,
  max_trade_loss_pct: 20,
  pyramid: false,
  pyramid_trigger_pct: 1.5,
};

// one live rule read: the saved live_rules value, else the live default
export function liveRule(LR, key, fb) {
  if (LR && LR[key] != null) return LR[key];
  if (LIVE_DEFAULTS[key] != null) return LIVE_DEFAULTS[key];
  return fb;
}

// the live desk's full rule view: live defaults underneath, its own saved
// live_rules on top — the paper config's own values are never part of it
export function liveRulesView(config) {
  const LR = (config || {}).live_rules || {};
  const saved = Object.fromEntries(Object.entries(LR).filter(([, v]) => v != null));
  return { ...config, ...LIVE_DEFAULTS, ...saved };
}