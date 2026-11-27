import React, { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { roundTo } from '@/lib/market';
import { bookRuleKeys, bookRuleSet } from '@/lib/bookRules';
import { Field, ScoreBarField, Toggle, WarningsBox, deskRuleWarnings, riskFields, scanEngineFields, marginFields, pyramidFields } from '@/components/bot/ruleFields';

const EXCHANGE_LABELS = {
  binance_us: 'Binance US',
  binance: 'Binance',
  bybit: 'Bybit',
  kucoin: 'KuCoin',
  kraken: 'Kraken',
};

// The live desk has a rules panel for each book. Both run the same engine and
// trade logic, but the dollar book saves into live_rules and the Bitcoin book
// into live_rules.live_btc_rules. One book's save never moves the other's.
export default function LiveRules({ config, onSaved, book = 'USD' }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(null);
  const [connections, setConnections] = useState([]);
  const isBtc = book === 'BTC';

  // a rule never saved shows this book's own default, never another book's value
  const fromConfig = (c) => {
    const lr = bookRuleSet(c, 'live', book);
    return {
      real_orders_enabled: c?.real_orders_enabled ?? false,
      real_connection_id: c?.real_connection_id || lr.real_connection_id || '',
      live_cap_usd: isBtc ? 0 : lr.live_cap_usd ?? c?.live_rules?.live_cap_usd ?? 0,
      score_bar: lr.score_bar ?? 70,
      risk_per_trade_pct: lr.risk_per_trade_pct ?? 4,
      max_open_positions: lr.max_open_positions ?? 8,
      daily_target_pct: lr.daily_target_pct ?? 2,
      cooldown_minutes: lr.cooldown_minutes ?? 120,
      trailing_stop: lr.trailing_stop ?? true,
      trailing_trigger_pct: lr.trailing_trigger_pct ?? 3,
      trailing_distance_pct: lr.trailing_distance_pct ?? 1.5,
      profit_lock: lr.profit_lock ?? true,
      lock_arm_pct: lr.lock_arm_pct ?? 2,
      giveback_pct: lr.giveback_pct ?? 50,
      trading_style: lr.trading_style ?? 'mild',
      timeframe: lr.timeframe ?? '1h',
      market_cap_scope: lr.market_cap_scope ?? 'all',
      sentiment_watch: lr.sentiment_watch ?? true,
      confluence_v2: lr.confluence_v2 ?? true,
      engine_v2: lr.engine_v2 ?? true,
      champion_engine: lr.champion_engine ?? true,
      btc_gate: lr.btc_gate ?? true,
      margin_engine: isBtc ? false : lr.margin_engine === true,
      margin_leverage: lr.margin_leverage ?? 2,
      max_trade_loss_pct: lr.max_trade_loss_pct ?? 20,
      pyramid: lr.pyramid === true,
      pyramid_trigger_pct: lr.pyramid_trigger_pct ?? 1.5,
      v3_algo: lr.v3_algo === true,
      always_take_top: lr.always_take_top === true,
      always_take_count: lr.always_take_count ?? 5,
      analyst_on: lr.analyst_on === true,
      btc_markets: lr.btc_markets === true,
      v3_exit: lr.v3_exit === true,
    };
  };
  const [live, setLive] = useState(() => fromConfig(config));

  // re-sync the form whenever a fresh config lands or the book changes
  useEffect(() => {
    if (config) setLive(fromConfig(config));
  }, [config, isBtc]);

  useEffect(() => {
    let alive = true;
    base44.entities.ExchangeConnection.filter({ status: 'connected', allow_trading: true }, { limit: 20, fields: ['id', 'exchange', 'label', 'testnet'] })
      .then((res) => {
        if (alive) setConnections(res.items || res || []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const setLiveV = (key) => (value) => setLive((prev) => ({ ...prev, [key]: value }));
  const setLiveNum = (key) => (event) => setLive((prev) => ({ ...prev, [key]: event.target.value }));

  const saveLive = async () => {
    setSaving('live');
    try {
      const all = {
        score_bar: Math.max(0, roundTo(Number(live.score_bar), 1)),
        risk_per_trade_pct: roundTo(live.risk_per_trade_pct, 2),
        max_open_positions: Math.max(1, Math.round(Number(live.max_open_positions) || 1)),
        daily_target_pct: roundTo(live.daily_target_pct, 2),
        cooldown_minutes: Math.max(0, Math.round(Number(live.cooldown_minutes) || 0)),
        trailing_stop: live.trailing_stop,
        trailing_trigger_pct: roundTo(live.trailing_trigger_pct, 2),
        trailing_distance_pct: roundTo(live.trailing_distance_pct, 2),
        profit_lock: live.profit_lock !== false,
        lock_arm_pct: roundTo(Number(live.lock_arm_pct) || 2, 2),
        giveback_pct: Math.max(0, Math.min(90, roundTo(Number(live.giveback_pct), 0))),
        trading_style: live.trading_style,
        timeframe: live.timeframe,
        market_cap_scope: live.market_cap_scope,
        sentiment_watch: live.sentiment_watch,
        confluence_v2: live.confluence_v2,
        engine_v2: live.engine_v2,
        champion_engine: live.champion_engine,
        btc_gate: live.btc_gate,
        margin_engine: isBtc ? false : live.margin_engine,
        margin_leverage: Math.max(1, Math.min(5, Math.round(Number(live.margin_leverage) || 2))),
        max_trade_loss_pct: roundTo(live.max_trade_loss_pct, 1),
        pyramid: live.pyramid === true,
        pyramid_trigger_pct: roundTo(Number(live.pyramid_trigger_pct) || 1.5, 2),
        v3_algo: live.v3_algo === true,
        always_take_top: live.always_take_top === true,
        always_take_count: Math.max(1, Math.min(10, Math.round(Number(live.always_take_count) || 5))),
        analyst_on: live.analyst_on === true,
        btc_markets: live.btc_markets === true,
        v3_exit: live.v3_exit === true,
      };
      const pick = Object.fromEntries(bookRuleKeys('live', book)
        // the BTC markets switch and the desk analyst belong to the whole desk
        .filter((key) => !['btc_markets', 'analyst_on'].includes(key) && all[key] != null)
        .map((key) => [key, all[key]]));
      // both books save into live_rules; the Bitcoin book under its own key, so
      // the dollar values it was seeded from stay exactly as they are. The
      // switches shared by the whole desk (real orders, the account, the BTC
      // markets toggle, the analyst) are written at the desk level.
      const saved = {
        ...(config.live_rules || {}),
        real_connection_id: live.real_connection_id || '',
        // the dollar cap is the dollar book's budget; the Bitcoin book spends the
        // account's own Bitcoin, so it never sets or clears it
        ...(isBtc ? {} : { live_cap_usd: roundTo(Number(live.live_cap_usd) || 0, 2) }),
        btc_markets: live.btc_markets === true,
        analyst_on: live.analyst_on === true,
        ...(isBtc ? { live_btc_rules: pick } : pick),
      };
      await base44.entities.BotConfig.update(config.id, {
        real_orders_enabled: live.real_orders_enabled,
        live_rules: saved,
      });
      toast({ title: `${isBtc ? 'Bitcoin' : 'Dollar'} live rules saved`, description: 'The other book’s rules are untouched.' });
      if (onSaved) onSaved();
    } catch (error) {
      toast({ title: 'Could not save', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="surface space-y-4 p-4">
      <div>
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Live bot rules · {isBtc ? 'Bitcoin book' : 'Dollar book'}</p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          These rules govern this live book only — the other book and the paper desk keep their own saved values. Both books run the same trade logic.
        </p>
      </div>

      <Toggle
        label="Real orders"
        hint="When on, live-qualified longs are sent as market orders to the chosen exchange. Auto opens them, approved proposals fire them."
        checked={live.real_orders_enabled}
        onChange={setLiveV('real_orders_enabled')}
      />
      {live.real_orders_enabled ? (
        <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
          <Field label="Exchange account" hint="Verified connections with trading enabled appear here.">
            <Select value={live.real_connection_id || undefined} onValueChange={setLiveV('real_connection_id')}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label || EXCHANGE_LABELS[c.exchange] || c.exchange}
                    {c.testnet ? ' (testnet)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Each real order is sized by Risk per trade % of the account's spendable balance, risked between entry and stop. Market orders only; real fills are tracked separately from the paper balance.
          </p>
          {isBtc ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              BTC markets are sized from the account's own Bitcoin spot balance, and take longs only. The dollar quote's cash is never spent on one, so turning BTC markets on cannot starve the dollar desk.
            </p>
          ) : (
            <>
              <p className="text-[11px] leading-snug text-muted-foreground">
                BTC markets are sized from the account's own Bitcoin spot balance instead, and take longs only. The dollar quote's cash is never spent on one, so turning BTC markets on cannot starve the dollar desk.
              </p>
              <Field
                label="Live budget cap ($)"
                hint="The most exchange money real orders may put to work in total across all open positions. 0 means no limit."
              >
                <Input className="num" inputMode="decimal" value={live.live_cap_usd} onChange={setLiveNum('live_cap_usd')} />
              </Field>
            </>
          )}
        </div>
      ) : null}

      <ScoreBarField form={live} setNum={setLiveNum} />

      {riskFields(live, setLiveNum, setLiveV)}

      {pyramidFields(live, setLiveNum, setLiveV)}

      {/* the profit lock: the one exit that runs on the schedule, so a live
          position keeps locking in profit while the app is closed */}
      <div className="space-y-3 rounded-xl border border-border/60 bg-secondary/20 p-3">
        <Toggle
          label="Profit lock"
          hint="Once a position is up by the arm threshold, its stop is raised to keep the share below of the best price it reached — so a run books most of itself instead of riding back down to the entry stop. It runs every five minutes on the desk guard, so it holds while the app is closed, and it can only ever raise a stop. The exit study is blunt about the trade-off: protecting the peak lifts the win rate and lowers the money per trade."
          checked={live.profit_lock !== false}
          onChange={setLiveV('profit_lock')}
        />
        {live.profit_lock !== false ? (
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Field label="Arm at gain %" hint="How far in profit a position must be before its stop is raised.">
              <Input
                className="num"
                inputMode="decimal"
                value={live.lock_arm_pct}
                onChange={setLiveNum('lock_arm_pct')}
              />
            </Field>
            <Field
              label="Give back %"
              hint="How much of the best profit the lock allows back. 50 keeps half the move, 40 keeps more but exits sooner, 0 turns it off."
            >
              <Input
                className="num"
                inputMode="decimal"
                value={live.giveback_pct}
                onChange={setLiveNum('giveback_pct')}
              />
            </Field>
          </div>
        ) : null}
      </div>

      {scanEngineFields(live, setLiveNum, setLiveV)}

      {!isBtc ? marginFields(live, setLiveNum, setLiveV) : null}

      <WarningsBox warnings={deskRuleWarnings(live)} />

      <Button className="w-full" onClick={saveLive} disabled={saving === 'live'}>
        {saving === 'live' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
        Save {isBtc ? 'Bitcoin' : 'dollar'} live rules
      </Button>
    </div>
  );
}
