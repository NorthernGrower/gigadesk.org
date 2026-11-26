import React, { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { roundTo } from '@/lib/market';
import { Field, ScoreBarField, Toggle, WarningsBox, deskRuleWarnings, riskFields, scanEngineFields, marginFields, pyramidFields } from '@/components/bot/ruleFields';

const EXCHANGE_LABELS = {
  binance_us: 'Binance US',
  binance: 'Binance',
  bybit: 'Bybit',
  kucoin: 'KuCoin',
  kraken: 'Kraken',
};

// The live desk's own rules — saved into live_rules, nothing here touches
// the paper desk.
export default function LiveRules({ config, onSaved }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(null);
  const [connections, setConnections] = useState([]);

  // live rules read only their own saved values — never a paper value. A
  // rule never saved shows and runs on its own live default.
  const fromConfig = (c) => {
    const lr = c?.live_rules || {};
    return {
      real_orders_enabled: c?.real_orders_enabled ?? false,
      real_connection_id: lr.real_connection_id || c?.real_connection_id || '',
      live_cap_usd: lr.live_cap_usd ?? 0,
      score_bar: lr.score_bar ?? 70,
      risk_per_trade_pct: lr.risk_per_trade_pct ?? 4,
      max_open_positions: lr.max_open_positions ?? 8,
      daily_target_pct: lr.daily_target_pct ?? 2,
      cooldown_minutes: lr.cooldown_minutes ?? 120,
      trailing_stop: lr.trailing_stop ?? true,
      trailing_trigger_pct: lr.trailing_trigger_pct ?? 3,
      trailing_distance_pct: lr.trailing_distance_pct ?? 1.5,
      trading_style: lr.trading_style ?? 'mild',
      timeframe: lr.timeframe ?? '1h',
      market_cap_scope: lr.market_cap_scope ?? 'all',
      sentiment_watch: lr.sentiment_watch ?? true,
      confluence_v2: lr.confluence_v2 ?? true,
      engine_v2: lr.engine_v2 ?? true,
      champion_engine: lr.champion_engine ?? true,
      btc_gate: lr.btc_gate ?? true,
      margin_engine: lr.margin_engine === true,
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

  // re-sync the form whenever a fresh config lands (after a save or a cycle)
  useEffect(() => {
    if (config) setLive(fromConfig(config));
  }, [config?.id, config?.updated_date]);

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
      await base44.entities.BotConfig.update(config.id, {
        real_orders_enabled: live.real_orders_enabled,
        live_rules: {
          real_connection_id: live.real_connection_id || '',
          live_cap_usd: roundTo(Number(live.live_cap_usd) || 0, 2),
          score_bar: Math.max(0, roundTo(Number(live.score_bar), 1)),
          risk_per_trade_pct: roundTo(live.risk_per_trade_pct, 2),
          max_open_positions: Math.max(1, Math.round(Number(live.max_open_positions) || 1)),
          daily_target_pct: roundTo(live.daily_target_pct, 2),
          cooldown_minutes: Math.max(0, Math.round(Number(live.cooldown_minutes) || 0)),
          trailing_stop: live.trailing_stop,
          trailing_trigger_pct: roundTo(live.trailing_trigger_pct, 2),
          trailing_distance_pct: roundTo(live.trailing_distance_pct, 2),
          trading_style: live.trading_style,
          timeframe: live.timeframe,
          market_cap_scope: live.market_cap_scope,
          sentiment_watch: live.sentiment_watch,
          confluence_v2: live.confluence_v2,
          engine_v2: live.engine_v2,
          champion_engine: live.champion_engine,
          btc_gate: live.btc_gate,
          margin_engine: live.margin_engine,
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
        },
      });
      toast({ title: 'Live rules saved', description: 'Real orders pick them up on the next cycle. Paper rules are untouched.' });
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
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Live bot rules</p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          These rules govern real orders on your exchange only — the paper desk keeps its own rules, saved separately.
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
          <p className="text-[11px] leading-snug text-muted-foreground">
            BTC markets are sized from the account's own Bitcoin spot balance instead, and take longs only. The dollar quote's cash is never spent on one, so turning BTC markets on cannot starve the dollar desk.
          </p>
          <Field
            label="Live budget cap ($)"
            hint="The most exchange money real orders may put to work in total across all open positions. 0 means no limit."
          >
            <Input className="num" inputMode="decimal" value={live.live_cap_usd} onChange={setLiveNum('live_cap_usd')} />
          </Field>
        </div>
      ) : null}

      <ScoreBarField form={live} setNum={setLiveNum} />

      {riskFields(live, setLiveNum, setLiveV)}

      {pyramidFields(live, setLiveNum, setLiveV)}

      {scanEngineFields(live, setLiveNum, setLiveV)}

      {marginFields(live, setLiveNum, setLiveV)}

      <WarningsBox warnings={deskRuleWarnings(live)} />

      <Button className="w-full" onClick={saveLive} disabled={saving === 'live'}>
        {saving === 'live' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
        Save live rules
      </Button>
    </div>
  );
}