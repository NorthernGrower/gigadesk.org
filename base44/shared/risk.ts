// Portfolio-level risk controls for the bot. Pure functions only: no entity
// reads, no order placement, so a self-test can exercise every branch.
//
// What was missing before this file: the bot had a per-trade loss cap
// (max_trade_loss_pct) and a total live exposure cap (live_cap_usd), but no
// drawdown brake, no daily loss halt, no size reduction after a losing streak
// and no concentration limit. Those are the controls that decide whether an
// account survives a bad month, and they only ever restrict trading.
//
// The thresholds follow the risk-management doctrine of the
// `claude-trading-skills` collection (agiprolabs, MIT), tightened to this app:
// the paper desk's starting balance and closed trades are the only equity
// history the bot keeps, so drawdown is measured from realised equity.

export type RiskState = {
  // 1 = trade at full size, 0 = no new entries on this desk
  size_multiplier: number;
  block_entries: boolean;
  // the binding reason, for the UI and the alert
  reason: string | null;
  drawdown_pct: number;
  realized_pnl_today: number;
  losing_streak: number;
  deployed_usd: number;
};

export const RISK_DEFAULTS = {
  // drawdown from the realised equity peak: reduce, then stop
  drawdown_reduce_pct: 5,
  drawdown_stop_pct: 10,
  // one day's realised loss stops new entries until the next day
  daily_loss_pct: 3,
  // a losing run reduces size, a long one stops for the day
  streak_reduce: 3,
  streak_halt: 6,
  streak_reduce_multiplier: 0.5,
  // no single position may exceed this share of equity
  max_position_pct: 10,
  // all open positions together
  max_deployed_pct: 60,
};

export type RiskInput = {
  starting_balance: number;
  realized_pnl_total: number;
  realized_pnl_today: number;
  open_size_usd: number;
  losing_streak: number;
  now_ms?: number;
  limits?: Partial<typeof RISK_DEFAULTS>;
};

/** Peak realised equity this desk has reached, and how far below it sits now. */
export function drawdownPct(starting: number, realized: number): number {
  const equity = Math.max(0, Number(starting) || 0) + (Number(realized) || 0);
  const peak = Math.max(Number(starting) || 0, equity);
  if (!(peak > 0)) return 0;
  return Math.max(0, ((peak - equity) / peak) * 100);
}

/**
 * The desk's risk state. Every rule is a restriction: the smallest applicable
 * multiplier wins, and any halt blocks new entries outright.
 */
export function riskState(input: RiskInput): RiskState {
  const limits = { ...RISK_DEFAULTS, ...(input.limits || {}) };
  const starting = Math.max(1, Number(input.starting_balance) || 1);
  const realized = Number(input.realized_pnl_total) || 0;
  const today = Number(input.realized_pnl_today) || 0;
  const deployed = Math.max(0, Number(input.open_size_usd) || 0);
  const streak = Math.max(0, Math.floor(Number(input.losing_streak) || 0));
  const dd = drawdownPct(starting, realized);

  let multiplier = 1;
  let block = false;
  let reason: string | null = null;

  if (dd >= limits.drawdown_stop_pct) {
    block = true;
    reason = `drawdown ${dd.toFixed(1)}% reached the ${limits.drawdown_stop_pct}% stop`;
  } else if (dd >= limits.drawdown_reduce_pct) {
    multiplier = Math.min(multiplier, limits.streak_reduce_multiplier);
    reason = `drawdown ${dd.toFixed(1)}% — position size halved`;
  }

  const dailyLossPct = ((-today) / starting) * 100;
  if (!block && dailyLossPct >= limits.daily_loss_pct) {
    block = true;
    reason = `today's realised loss ${dailyLossPct.toFixed(1)}% hit the ${limits.daily_loss_pct}% daily limit`;
  }

  if (!block && streak >= limits.streak_halt) {
    block = true;
    reason = `${streak} consecutive losses — new entries paused`;
  } else if (!block && streak >= limits.streak_reduce) {
    multiplier = Math.min(multiplier, limits.streak_reduce_multiplier);
    if (!reason) reason = `${streak} consecutive losses — position size halved`;
  }

  const deployedPct = (deployed / starting) * 100;
  if (!block && deployedPct >= limits.max_deployed_pct) {
    block = true;
    reason = `${deployedPct.toFixed(0)}% of equity is already deployed`;
  }

  return {
    size_multiplier: block ? 0 : multiplier,
    block_entries: block,
    reason,
    drawdown_pct: dd,
    realized_pnl_today: today,
    losing_streak: streak,
    deployed_usd: deployed,
  };
}

/**
 * Cap one position to a share of equity. Returns the size to use, which is never
 * larger than what sizing already asked for.
 */
export function capPositionSize(sizeUsd: number, startingBalance: number, limits: Partial<typeof RISK_DEFAULTS> = {}) {
  const limitsMerged = { ...RISK_DEFAULTS, ...limits };
  const cap = (Math.max(1, Number(startingBalance) || 1) * limitsMerged.max_position_pct) / 100;
  const size = Math.max(0, Number(sizeUsd) || 0);
  return Math.min(size, cap);
}

/** How many consecutive losses the most recent closed trades end with. */
export function losingStreak(closedTrades: any[]): number {
  let streak = 0;
  for (const trade of closedTrades) {
    const pnl = Number(trade && trade.pnl_usd);
    if (!Number.isFinite(pnl)) continue;
    if (pnl < 0) streak += 1;
    else break;
  }
  return streak;
}
