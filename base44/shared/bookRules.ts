// The Bitcoin books' own rule sets. The dollar book and the Bitcoin book run the
// same engine and the same trade logic, but each keeps its own values: the paper
// Bitcoin book reads btc_rules, the live Bitcoin book reads live_btc_rules. Each
// is seeded once from the dollar desk's values, so nothing changes on upgrade,
// and from then on a dollar rule change never reaches a Bitcoin book.

// the trade rules each book keeps its own copy of (the rules panel's values)
export const BOOK_RULE_KEYS = [
  "profit_mode",
  "score_bar",
  "risk_per_trade_pct",
  "max_open_positions",
  "daily_target_pct",
  "cooldown_minutes",
  "trailing_stop",
  "trailing_trigger_pct",
  "trailing_distance_pct",
  "allow_shorts",
  "trading_style",
  "timeframe",
  "market_cap_scope",
  "sentiment_watch",
  "confluence_v2",
  "engine_v2",
  "champion_engine",
  "btc_gate",
  "combo_engine",
  "max_trade_loss_pct",
  "pyramid",
  "pyramid_trigger_pct",
  "v3_algo",
  "v3_exit",
  "always_take_top",
  "always_take_count",
  "profit_lock",
  "lock_arm_pct",
  "giveback_pct",
];

// the value a rule takes when neither the book nor its desk has one saved
export const BOOK_RULE_DEFAULTS: Record<string, any> = {
  profit_mode: "compound",
  score_bar: 70,
  risk_per_trade_pct: 4,
  max_open_positions: 8,
  daily_target_pct: 2,
  cooldown_minutes: 120,
  trailing_stop: true,
  trailing_trigger_pct: 3,
  trailing_distance_pct: 1.5,
  allow_shorts: true,
  trading_style: "mild",
  timeframe: "1h",
  market_cap_scope: "all",
  sentiment_watch: true,
  confluence_v2: true,
  engine_v2: true,
  champion_engine: true,
  btc_gate: true,
  combo_engine: true,
  max_trade_loss_pct: 20,
  pyramid: false,
  pyramid_trigger_pct: 1.5,
  v3_algo: false,
  v3_exit: false,
  always_take_top: false,
  always_take_count: 5,
  profit_lock: true,
  lock_arm_pct: 2,
  giveback_pct: 50,
};

/** A book's rule set, copied from the view it is seeded from. */
export function seedBookRules(view: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of BOOK_RULE_KEYS) {
    const value = view ? view[key] : undefined;
    out[key] = value == null ? BOOK_RULE_DEFAULTS[key] : value;
  }
  return out;
}

/**
 * A Bitcoin book's full rule view: its own saved rules on top, then the desk's
 * view it was seeded from, then the default. The margin engine is a dollar
 * market feature, so it is always off on a Bitcoin book.
 */
export function btcBookView(base: any, saved: any): any {
  const rules: Record<string, any> = {};
  for (const key of BOOK_RULE_KEYS) {
    if (saved && saved[key] != null) rules[key] = saved[key];
    else if (base && base[key] != null) rules[key] = base[key];
    else rules[key] = BOOK_RULE_DEFAULTS[key];
  }
  return { ...base, ...rules, margin_engine: false };
}
