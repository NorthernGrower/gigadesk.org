// One managed entry policy for every desk, account and setup check.
// The COMBO layer is the optimizer's round 25-28 champion: every independent
// winner from the optimization sessions stacked into one tested configuration.
// A backtest of $10,000 returned +$1,419.13 (+14.19%) over 6 months on 1h
// candles with 0.5% round-trip costs - 9 trades, 77.8% win rate, profit
// factor 23.56, max drawdown 0.6%, worst losing streak 2.
// The margin engine's tested universe (optimizer rounds 29-36): the nine
// majors plus AVAX — widened small caps bleed on margin fees.
export const MARGIN_UNIVERSE = new Set([
  "BTC", "ETH", "SOL", "XRP", "ADA", "DOT", "LINK", "LTC", "DOGE", "AVAX",
]);

export function entryRulesFor(config = {}, desk = "paper", btcChange24h = null) {
  const combo = config.combo_engine !== false;
  const margin = config.margin_engine === true;
  const style = config.trading_style || "mild";
  return {
    // the combo stack's tested score bar; styles keep bending sizing, not the bar
    min_score: combo ? 70 : style === "timid" ? 68 : style === "aggressive" ? 58 : 62,
    // shorts on the live desk are a margin-engine feature: the margin account
    // can open them without holdings, a spot account cannot
    allow_shorts: config.allow_shorts !== false && (desk === "paper" || margin),
    combo,
    margin,
    target_r: margin ? 3 : combo ? 6 : null,
    btc_change24h: btcChange24h,
  };
}

export function gateReason(row, desk, rules) {
  if ((Number(row.score) || 0) < rules.min_score) return "score under the managed minimum";
  if (row.side !== "long" && !rules.allow_shorts)
    return desk === "live" ? "short setup (live desk takes longs only — margin engine off)" : "shorts are switched off";
  const entry = Number(row.entry), stop = Number(row.stop), target = Number(row.target);
  if (![entry, stop, target].every(n => Number.isFinite(n) && n > 0)) return "invalid trade levels";
  const long = row.side === "long";
  if (long ? stop >= entry || target <= entry : stop <= entry || target >= entry)
    return "trade levels face the wrong direction";
  // Range/unknown higher-timeframe readings are not a veto. A confirmed
  // opposing trend still is; score and momentum qualify early trend entries.
  if (row.htf_trend === (long ? "down" : "up")) return "higher timeframe opposes the trade";
  const ind = row.indicators || {};
  if ((Number(ind.adx) || 0) < 15) return "ADX under 15";
  if (long ? Number(ind.plus_di) <= Number(ind.minus_di) : Number(ind.minus_di) <= Number(ind.plus_di))
    return "momentum opposes the trade";
  if ((Number(row.confluence) || 0) < 3) return "under 3 confluences";
  // An unfinished candle is not required to beat a full-candle volume average.
  // Keep activity screening, but accept recent flow as well as the current bar.
  if (Math.max(Number(ind.vol_ratio) || 0, Number(ind.vol_ratio_3) || 0) <= 0)
    return "no recent trading activity";
  if (Number(ind.ema20) > 0) {
    const stretch = (Number(row.price) / Number(ind.ema20) - 1) * 100 * (long ? 1 : -1);
    if (stretch > 5) return "stretch over 5%";
  }
  if (row.fib_phase === "chasing") return "entry is chasing";
  if (rules.combo !== false) {
    // ---- COMBO ENGINE gates (round 25-28 champion), layered on the managed gate
    // margin engine: only the tested majors + AVAX universe is traded
    if (rules.margin && !MARGIN_UNIVERSE.has(String(row.symbol || "").toUpperCase()))
      return "margin engine trades the majors + AVAX only";
    if ((Number(ind.adx) || 0) < 28) return "ADX under 28 (combo requires a strong trend)";
    const vr = Number(ind.vol_ratio) || 0;
    if (vr < 2) return "signal bar volume under 2x its average";
    if (vr > 4) return "signal bar volume over 4x (blow-off volume)";
    const k = Number(ind.stoch_k) || 0, d = Number(ind.stoch_d) || 0;
    if (long ? k < d : k > d) return "stochastic pair opposes the trade";
    // RSI chase block, longs only: the short-only optimizer's round-38/39
    // winner - in a downtrend RSI sits pinned oversold while price keeps
    // falling, so the under-28 block was refusing the short leg's best
    // entries. Removing it nearly tripled short-side net P&L over the pooled
    // 12-month test (+$1,486 vs +$589) and won consistently in both
    // 6-month blocks; the longs' over-72 block stays untouched.
    const rsiVal = Number(ind.rsi) || 0;
    if (long && rsiVal > 72) return "RSI chasing the move (over 72)";
    const conviction = rules.margin ? 0.5 : 0.6;
    if ((Number(row.body_ratio) || 0) < conviction)
      return `signal bar lacks conviction (body under ${Math.round(conviction * 100)}%)`;
    // regime: the longs only traded into a risk-off BTC tape; shorts wait
    // out a flat one - measured on BTC's 24h move (over +1% risk-on,
    // under -1% risk-off, in between sideways)
    const btc = Number(rules.btc_change24h);
    if (Number.isFinite(btc)) {
      if (long && btc > -1) return "longs wait for a risk-off BTC tape";
      if (!long && btc <= 1 && btc >= -1) return "shorts wait out a flat BTC tape";
    }
    // the engine target (6R, or 3R under the margin engine) must still
    // clear the daily goal on the trade's own stop
    if ((Number(row.stop_pct) || 2) * (Number(rules.target_r) || 6) < 2)
      return "target move under the daily goal";
  }
  return null;
}

/** The smallest USD order a pair will accept on this exchange, or $10. */
export function entryMinimum(constraints, symbol, quoteAsset, entry) {
  const pair = `${String(symbol || "").toUpperCase()}${quoteAsset || "USDT"}`;
  const m = constraints ? constraints.get(pair) : null;
  return Math.max(10, Number(m?.minNotional) || 0, (Number(m?.minQty) || 0) * entry * 1.01);
}

export function liveEntrySize({ row, balance, budget, slots, riskPct, minimum = 10 }) {
  const available = Math.min(Math.max(0, balance) * 0.995, Math.max(0, budget));
  const minOrder = Math.max(10, Number(minimum) || 10);
  if (available < minOrder) return 0;
  const affordableSlots = Math.max(1, Math.min(slots, Math.floor(available / minOrder)));
  const stopDistance = Math.abs(Number(row.entry) - Number(row.stop));
  if (!(stopDistance > 0)) return 0;
  const riskCap = ((balance * riskPct / 100) / stopDistance) * Number(row.entry);
  const size = Math.floor(Math.min(riskCap, available / affordableSlots) * 100) / 100;
  return size >= minOrder ? size : 0;
}