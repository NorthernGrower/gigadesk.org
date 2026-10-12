// One managed entry policy for every desk, account and setup check.
export function entryRulesFor(config = {}, desk = "paper") {
  const style = config.trading_style || "mild";
  return { min_score: style === "timid" ? 68 : style === "aggressive" ? 58 : 62,
    allow_shorts: desk === "paper" && config.allow_shorts !== false };
}

export function gateReason(row, desk, rules) {
  if ((Number(row.score) || 0) < rules.min_score) return "score under the managed minimum";
  if (row.side !== "long" && (desk === "live" || !rules.allow_shorts))
    return desk === "live" ? "short setup (real orders take longs only)" : "shorts are switched off";
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
  return null;
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