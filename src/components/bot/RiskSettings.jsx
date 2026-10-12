import React, { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/use-toast';
import { TIMEFRAMES, TIERS, pageItems, roundTo } from '@/lib/market';

const EXCHANGE_LABELS = {
  binance_us: 'Binance US',
  binance: 'Binance',
  bybit: 'Bybit',
  kucoin: 'KuCoin',
  kraken: 'Kraken',
};

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-secondary/20 px-3 py-2.5">
      <div>
        <p className="text-xs font-medium">{label}</p>
        {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export default function RiskSettings({ config, onSaved }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    trading_style: config?.trading_style || 'mild',
    starting_balance: config?.starting_balance ?? 10000,
    risk_per_trade_pct: config?.risk_per_trade_pct ?? 4,
    max_open_positions: config?.max_open_positions ?? 8,
    daily_target_pct: config?.daily_target_pct ?? 2,
    min_score: config?.min_score ?? 62,
    cooldown_minutes: config?.cooldown_minutes ?? 120,
    trailing_trigger_pct: config?.trailing_trigger_pct ?? 3,
    trailing_distance_pct: config?.trailing_distance_pct ?? 1.5,
    trailing_stop: config?.trailing_stop ?? true,
    allow_shorts: config?.allow_shorts ?? true,
    require_daily_target: config?.require_daily_target ?? true,
    auto_run: config?.auto_run ?? true,
    profit_mode: config?.profit_mode || 'compound',
    sentiment_watch: config?.sentiment_watch ?? true,
    timeframe: config?.timeframe || '1h',
    market_cap_scope: config?.market_cap_scope || 'all',
    real_orders_enabled: config?.real_orders_enabled ?? false,
    real_connection_id: config?.real_connection_id || '',
    real_sizing_mode: config?.real_sizing_mode || 'paper',
    fixed_order_usd: config?.fixed_order_usd ?? 100,
    live_cap_usd: config?.live_cap_usd ?? 0,
  });
  const [saving, setSaving] = useState(false);
  const [connections, setConnections] = useState([]);

  useEffect(() => {
    let alive = true;
    base44.entities.ExchangeConnection.filter({ status: 'connected', allow_trading: true }, { limit: 20, fields: ['id', 'exchange', 'label', 'testnet'] })
      .then((res) => {
        if (alive) setConnections(pageItems(res));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));
  const setNum = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      await base44.entities.BotConfig.update(config.id, {
        trading_style: form.trading_style,
        starting_balance: roundTo(form.starting_balance, 2),
        risk_per_trade_pct: roundTo(form.risk_per_trade_pct, 2),
        max_open_positions: Math.max(1, Math.round(Number(form.max_open_positions) || 1)),
        daily_target_pct: roundTo(form.daily_target_pct, 2),
        target_pct: roundTo(form.daily_target_pct, 2),
        min_score: Math.round(Number(form.min_score) || 0),
        cooldown_minutes: Math.max(0, Math.round(Number(form.cooldown_minutes) || 0)),
        trailing_trigger_pct: roundTo(form.trailing_trigger_pct, 2),
        trailing_distance_pct: roundTo(form.trailing_distance_pct, 2),
        trailing_stop: form.trailing_stop,
        allow_shorts: form.allow_shorts,
        require_daily_target: form.require_daily_target,
        auto_run: form.auto_run,
        profit_mode: form.profit_mode,
        sentiment_watch: form.sentiment_watch,
        timeframe: form.timeframe,
        market_cap_scope: form.market_cap_scope,
        real_orders_enabled: form.real_orders_enabled,
        real_connection_id: form.real_connection_id || '',
        real_sizing_mode: form.real_sizing_mode,
        fixed_order_usd: roundTo(form.fixed_order_usd, 2),
        live_cap_usd: roundTo(Number(form.live_cap_usd) || 0, 2),
      });
      toast({ title: 'Risk rules saved', description: 'The bot picks them up on its next cycle.' });
      if (onSaved) onSaved();
    } catch (error) {
      toast({ title: 'Could not save', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const resetBalance = async () => {
    setSaving(true);
    try {
      const balance = roundTo(form.starting_balance, 2);
      await base44.entities.BotConfig.update(config.id, {
        starting_balance: balance,
        cash_balance: balance,
      });
      toast({ title: 'Paper balance reset', description: `Back to $${balance.toLocaleString()}.` });
      if (onSaved) onSaved();
    } catch (error) {
      toast({ title: 'Could not reset', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="surface space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Risk rules</p>
        <Button size="sm" variant="ghost" className="h-7 text-[11px] text-muted-foreground" onClick={resetBalance} disabled={saving}>
          Reset paper balance
        </Button>
      </div>

      <Field
        label="Trading style"
        hint={
          form.trading_style === 'timid'
            ? 'Waits for stronger setups (score +6) and risks 25% less per trade.'
            : form.trading_style === 'aggressive'
              ? 'Takes more setups (score -5), risks 40% more per trade, and cuts any trade sitting still for 12 hours to move on faster.'
              : 'Trades exactly by the rules below.'
        }
      >
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: 'timid', label: 'Timid' },
            { value: 'mild', label: 'Mild' },
            { value: 'aggressive', label: 'Aggressive' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => set('trading_style')(option.value)}
              className={`h-9 rounded-md border text-xs font-medium transition-colors ${
                form.trading_style === option.value
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border/60 bg-transparent text-muted-foreground hover:bg-secondary/40'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Starting balance" hint="Your paper bankroll in USD.">
          <Input className="num" inputMode="decimal" value={form.starting_balance} onChange={setNum('starting_balance')} />
        </Field>
        <Field label="Risk per trade %" hint="Share of the balance risked between entry and stop.">
          <Input className="num" inputMode="decimal" value={form.risk_per_trade_pct} onChange={setNum('risk_per_trade_pct')} />
        </Field>
        <Field label="Max open positions">
          <Input className="num" inputMode="numeric" value={form.max_open_positions} onChange={setNum('max_open_positions')} />
        </Field>
        <Field label="Daily target %" hint="Setups must be able to move this much to qualify.">
          <Input className="num" inputMode="decimal" value={form.daily_target_pct} onChange={setNum('daily_target_pct')} />
        </Field>
        <Field label="Minimum score" hint="Only setups ranked at or above this score are taken.">
          <Input className="num" inputMode="numeric" value={form.min_score} onChange={setNum('min_score')} />
        </Field>
        <Field label="Cooldown (minutes)" hint="How long a coin is left alone after a trade closes.">
          <Input className="num" inputMode="numeric" value={form.cooldown_minutes} onChange={setNum('cooldown_minutes')} />
        </Field>
        <Field label="Scan timeframe">
          <Select value={form.timeframe} onValueChange={set('timeframe')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEFRAMES.map((tf) => (
                <SelectItem key={tf.value} value={tf.value}>
                  {tf.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Profit handling"
          hint={
            form.profit_mode === 'stack'
              ? 'Profits are set aside and only the starting capital (plus losses) stays in the pool.'
              : 'Booked profits roll back into the pool and grow future position sizes.'
          }
        >
          <Select value={form.profit_mode} onValueChange={set('profit_mode')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="compound">Compound profits</SelectItem>
              <SelectItem value="stack">Stack profits aside</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Market coverage">
          <Select value={form.market_cap_scope} onValueChange={set('market_cap_scope')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIERS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        <Toggle
          label="Trailing stop"
          hint={`Locks in profit once a trade is up ${form.trailing_trigger_pct}%.`}
          checked={form.trailing_stop}
          onChange={set('trailing_stop')}
        />
        <Toggle
          label="Short trades"
          hint="Let the bot profit from breakdowns as well as breakouts."
          checked={form.allow_shorts}
          onChange={set('allow_shorts')}
        />
        <Toggle
          label="Require target coverage"
          hint={`Only take setups that can move ${form.daily_target_pct}% to target.`}
          checked={form.require_daily_target}
          onChange={set('require_daily_target')}
        />
        <Toggle
          label="Auto-run while open"
          hint="Runs a cycle in the background every few minutes."
          checked={form.auto_run}
          onChange={set('auto_run')}
        />
        <Toggle
          label="Market tone watch"
          hint="Every full cycle re-reads the chart behind each open trade and closes ones the market has turned against."
          checked={form.sentiment_watch}
          onChange={set('sentiment_watch')}
        />
        <Toggle
          label="Structure engine v2"
          hint="Adds Fibonacci pullback zones, Elliott wave counts and multi-touch support/resistance to scoring, with stale-breakout discounts. Turn off to revert to the previous engine."
          checked={form.confluence_v2 !== false}
          onChange={set('confluence_v2')}
        />
      </div>

      {form.trailing_stop ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Arm trailing stop at" hint="The gain a trade must reach before the trail locks in.">
            <Select value={String(form.trailing_trigger_pct)} onValueChange={(v) => set('trailing_trigger_pct')(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from(new Set([1, 1.5, 2, 3, 5, 7, 10, Number(form.trailing_trigger_pct)]))
                  .sort((a, b) => a - b)
                  .map((pct) => (
                    <SelectItem key={pct} value={String(pct)}>
                      {pct}% gain
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Trail distance %">
            <Input className="num" inputMode="decimal" value={form.trailing_distance_pct} onChange={setNum('trailing_distance_pct')} />
          </Field>
        </div>
      ) : null}

      <Toggle
        label="Real orders"
        hint="When on, qualifying longs are sent as market orders to the chosen exchange — Auto opens them and approved proposals fire them. Shorts stay paper."
        checked={form.real_orders_enabled}
        onChange={set('real_orders_enabled')}
      />

      {form.real_orders_enabled ? (
        <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
          <Field label="Exchange account" hint="Verified connections with trading enabled appear here.">
            <Select value={form.real_connection_id || undefined} onValueChange={set('real_connection_id')}>
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Order sizing" hint="What each real order spends.">
              <Select value={form.real_sizing_mode} onValueChange={set('real_sizing_mode')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="paper">Match paper sizing</SelectItem>
                  <SelectItem value="fixed">Fixed amount</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {form.real_sizing_mode === 'fixed' ? (
              <Field label="Fixed order ($)" hint="Spent on every real order.">
                <Input className="num" inputMode="decimal" value={form.fixed_order_usd} onChange={setNum('fixed_order_usd')} />
              </Field>
            ) : null}
          </div>
          <Field
            label="Live budget cap ($)"
            hint="The most exchange money the bot may put to work in total across all open positions. 0 means no limit — it will use as much of the balance as your sizing rules allow."
          >
            <Input className="num" inputMode="decimal" value={form.live_cap_usd} onChange={setNum('live_cap_usd')} />
          </Field>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Market orders only. Real fills are tracked separately from the paper balance, and the bot closes a real position by selling the same amount on the same account.
          </p>
        </div>
      ) : null}

      <Button className="w-full" onClick={save} disabled={saving}>
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
        Save risk rules
      </Button>
    </div>
  );
}