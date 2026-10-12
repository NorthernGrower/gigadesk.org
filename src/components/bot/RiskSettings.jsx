import React, { useEffect, useState } from 'react';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

// The rule fields both desks share: risk, slots, score bar, target, cooldown
// and trailing. Live saves them into live_rules, paper into the desk fields.
function sharedDeskFields(form, setNum, set) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Risk per trade %" hint="Share of the balance risked between entry and stop.">
        <Input className="num" inputMode="decimal" value={form.risk_per_trade_pct} onChange={setNum('risk_per_trade_pct')} />
      </Field>
      <Field label="Max open positions">
        <Input className="num" inputMode="numeric" value={form.max_open_positions} onChange={setNum('max_open_positions')} />
      </Field>
      <Field label="Minimum score" hint="Only setups ranked at or above this score are taken.">
        <Input className="num" inputMode="numeric" value={form.min_score} onChange={setNum('min_score')} />
      </Field>
      <Field label="Daily target %" hint="Setups must be able to move this much to qualify.">
        <Input className="num" inputMode="decimal" value={form.daily_target_pct} onChange={setNum('daily_target_pct')} />
      </Field>
      <Field label="Cooldown (minutes)" hint="How long a coin is left alone after a trade closes.">
        <Input className="num" inputMode="numeric" value={form.cooldown_minutes} onChange={setNum('cooldown_minutes')} />
      </Field>
      <Toggle
        label="Require target coverage"
        hint={`Only take setups that can move ${form.daily_target_pct}% to target.`}
        checked={form.require_daily_target}
        onChange={set('require_daily_target')}
      />
      <Toggle
        label="Trailing stop"
        hint={`Locks in profit once a trade is up ${form.trailing_trigger_pct}%.`}
        checked={form.trailing_stop}
        onChange={set('trailing_stop')}
      />
      {form.trailing_stop ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}

export default function RiskSettings({ config, onSaved }) {
  const { toast } = useToast();
  const [desk, setDesk] = useState('live');
  const [saving, setSaving] = useState(null);
  const [connections, setConnections] = useState([]);
  const lr = config?.live_rules || {};

  const [live, setLive] = useState({
    real_orders_enabled: config?.real_orders_enabled ?? false,
    real_connection_id: lr.real_connection_id || config?.real_connection_id || '',
    live_cap_usd: lr.live_cap_usd ?? config?.live_cap_usd ?? 0,
    risk_per_trade_pct: lr.risk_per_trade_pct ?? config?.risk_per_trade_pct ?? 4,
    max_open_positions: lr.max_open_positions ?? config?.max_open_positions ?? 8,
    min_score: lr.min_score ?? config?.min_score ?? 62,
    daily_target_pct: lr.daily_target_pct ?? config?.daily_target_pct ?? 2,
    cooldown_minutes: lr.cooldown_minutes ?? config?.cooldown_minutes ?? 120,
    trailing_stop: lr.trailing_stop ?? config?.trailing_stop ?? true,
    trailing_trigger_pct: lr.trailing_trigger_pct ?? config?.trailing_trigger_pct ?? 3,
    trailing_distance_pct: lr.trailing_distance_pct ?? config?.trailing_distance_pct ?? 1.5,
    require_daily_target: lr.require_daily_target ?? config?.require_daily_target ?? true,
  });
  const [paper, setPaper] = useState({
    starting_balance: config?.starting_balance ?? 10000,
    profit_mode: config?.profit_mode || 'compound',
    risk_per_trade_pct: config?.risk_per_trade_pct ?? 4,
    max_open_positions: config?.max_open_positions ?? 8,
    min_score: config?.min_score ?? 62,
    daily_target_pct: config?.daily_target_pct ?? 2,
    cooldown_minutes: config?.cooldown_minutes ?? 120,
    trailing_stop: config?.trailing_stop ?? true,
    trailing_trigger_pct: config?.trailing_trigger_pct ?? 3,
    trailing_distance_pct: config?.trailing_distance_pct ?? 1.5,
    require_daily_target: config?.require_daily_target ?? true,
    allow_shorts: config?.allow_shorts ?? true,
  });
  const [shared, setShared] = useState({
    trading_style: config?.trading_style || 'mild',
    timeframe: config?.timeframe || '1h',
    market_cap_scope: config?.market_cap_scope || 'all',
    sentiment_watch: config?.sentiment_watch ?? true,
    confluence_v2: config?.confluence_v2 !== false,
    engine_v2: config?.engine_v2 !== false,
    champion_engine: config?.champion_engine !== false,
  });

  // re-sync the forms whenever a fresh config lands (after a save or a cycle)
  useEffect(() => {
    if (!config) return;
    const rules = config.live_rules || {};
    setLive({
      real_orders_enabled: config.real_orders_enabled ?? false,
      real_connection_id: rules.real_connection_id || config.real_connection_id || '',
      live_cap_usd: rules.live_cap_usd ?? config.live_cap_usd ?? 0,
      risk_per_trade_pct: rules.risk_per_trade_pct ?? config.risk_per_trade_pct ?? 4,
      max_open_positions: rules.max_open_positions ?? config.max_open_positions ?? 8,
      min_score: rules.min_score ?? config.min_score ?? 62,
      daily_target_pct: rules.daily_target_pct ?? config.daily_target_pct ?? 2,
      cooldown_minutes: rules.cooldown_minutes ?? config.cooldown_minutes ?? 120,
      trailing_stop: rules.trailing_stop ?? config.trailing_stop ?? true,
      trailing_trigger_pct: rules.trailing_trigger_pct ?? config.trailing_trigger_pct ?? 3,
      trailing_distance_pct: rules.trailing_distance_pct ?? config.trailing_distance_pct ?? 1.5,
      require_daily_target: rules.require_daily_target ?? config.require_daily_target ?? true,
    });
    setPaper({
      starting_balance: config.starting_balance ?? 10000,
      profit_mode: config.profit_mode || 'compound',
      risk_per_trade_pct: config.risk_per_trade_pct ?? 4,
      max_open_positions: config.max_open_positions ?? 8,
      min_score: config.min_score ?? 62,
      daily_target_pct: config.daily_target_pct ?? 2,
      cooldown_minutes: config.cooldown_minutes ?? 120,
      trailing_stop: config.trailing_stop ?? true,
      trailing_trigger_pct: config.trailing_trigger_pct ?? 3,
      trailing_distance_pct: config.trailing_distance_pct ?? 1.5,
      require_daily_target: config.require_daily_target ?? true,
      allow_shorts: config.allow_shorts ?? true,
    });
    setShared({
      trading_style: config.trading_style || 'mild',
      timeframe: config.timeframe || '1h',
      market_cap_scope: config.market_cap_scope || 'all',
      sentiment_watch: config.sentiment_watch ?? true,
      confluence_v2: config.confluence_v2 !== false,
      engine_v2: config.engine_v2 !== false,
      champion_engine: config.champion_engine !== false,
    });
  }, [config?.id, config?.updated_date]);

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

  const setLiveV = (key) => (value) => setLive((prev) => ({ ...prev, [key]: value }));
  const setLiveNum = (key) => (event) => setLive((prev) => ({ ...prev, [key]: event.target.value }));
  const setPaperV = (key) => (value) => setPaper((prev) => ({ ...prev, [key]: value }));
  const setPaperNum = (key) => (event) => setPaper((prev) => ({ ...prev, [key]: event.target.value }));
  const setSharedV = (key) => (value) => setShared((prev) => ({ ...prev, [key]: value }));

  const saveLive = async () => {
    setSaving('live');
    try {
      await base44.entities.BotConfig.update(config.id, {
        real_orders_enabled: live.real_orders_enabled,
        live_rules: {
          real_connection_id: live.real_connection_id || '',
          live_cap_usd: roundTo(Number(live.live_cap_usd) || 0, 2),
          risk_per_trade_pct: roundTo(live.risk_per_trade_pct, 2),
          max_open_positions: Math.max(1, Math.round(Number(live.max_open_positions) || 1)),
          min_score: Math.round(Number(live.min_score) || 0),
          daily_target_pct: roundTo(live.daily_target_pct, 2),
          cooldown_minutes: Math.max(0, Math.round(Number(live.cooldown_minutes) || 0)),
          trailing_stop: live.trailing_stop,
          trailing_trigger_pct: roundTo(live.trailing_trigger_pct, 2),
          trailing_distance_pct: roundTo(live.trailing_distance_pct, 2),
          require_daily_target: live.require_daily_target,
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

  const savePaper = async () => {
    setSaving('paper');
    try {
      await base44.entities.BotConfig.update(config.id, {
        starting_balance: roundTo(paper.starting_balance, 2),
        profit_mode: paper.profit_mode,
        risk_per_trade_pct: roundTo(paper.risk_per_trade_pct, 2),
        max_open_positions: Math.max(1, Math.round(Number(paper.max_open_positions) || 1)),
        daily_target_pct: roundTo(paper.daily_target_pct, 2),
        target_pct: roundTo(paper.daily_target_pct, 2),
        min_score: Math.round(Number(paper.min_score) || 0),
        cooldown_minutes: Math.max(0, Math.round(Number(paper.cooldown_minutes) || 0)),
        trailing_trigger_pct: roundTo(paper.trailing_trigger_pct, 2),
        trailing_distance_pct: roundTo(paper.trailing_distance_pct, 2),
        trailing_stop: paper.trailing_stop,
        allow_shorts: paper.allow_shorts,
        require_daily_target: paper.require_daily_target,
      });
      toast({ title: 'Paper rules saved', description: 'The paper desk picks them up on its next cycle. Live rules are untouched.' });
      if (onSaved) onSaved();
    } catch (error) {
      toast({ title: 'Could not save', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  const saveShared = async () => {
    setSaving('shared');
    try {
      await base44.entities.BotConfig.update(config.id, {
        trading_style: shared.trading_style,
        timeframe: shared.timeframe,
        market_cap_scope: shared.market_cap_scope,
        sentiment_watch: shared.sentiment_watch,
        confluence_v2: shared.confluence_v2,
        engine_v2: shared.engine_v2,
        champion_engine: shared.champion_engine,
      });
      toast({ title: 'Shared settings saved', description: 'Both desks scan with these on the next cycle.' });
      if (onSaved) onSaved();
    } catch (error) {
      toast({ title: 'Could not save', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  // full reset: wipes every paper trade, the equity history, the bot's
  // lessons and those trades' alerts, then puts the balance back to the
  // starting amount — the desk is as good as brand new
  const resetBalance = async () => {
    if (!window.confirm('Reset the paper desk? This deletes every paper trade, its lessons and the equity history, and sets the balance back to the starting amount.')) return;
    setSaving('paper');
    try {
      const res = await base44.functions.invoke('resetPaperTrading', {});
      const data = res.data || {};
      const balance = roundTo(data.starting_balance ?? paper.starting_balance, 2);
      const counts = data.counts || {};
      toast({
        title: 'Paper desk reset',
        description: `${counts.paper_trades ?? 0} paper trades and ${counts.lessons ?? 0} lessons cleared. Balance back to $${balance.toLocaleString()}.`,
      });
      if (onSaved) onSaved();
    } catch (error) {
      toast({ title: 'Could not reset', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  const deskButton = (value) => `h-9 rounded-md border text-xs font-medium transition-colors ${
    desk === value
      ? 'border-primary bg-primary/15 text-primary'
      : 'border-border/60 bg-transparent text-muted-foreground hover:bg-secondary/40'
  }`;

  return (
    <div className="surface space-y-4 p-4" id="risk-rules">
      <div>
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Bot rules</p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          Live rules govern real orders on your exchange only. Paper rules govern the paper desk only — neither touches the other.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={deskButton('live')} onClick={() => setDesk('live')}>
          Live rules (real orders)
        </button>
        <button type="button" className={deskButton('paper')} onClick={() => setDesk('paper')}>
          Paper rules
        </button>
      </div>

      {desk === 'live' ? (
        <div className="space-y-4">
          <Toggle
            label="Real orders"
            hint="When on, live-qualified longs are sent as market orders to the chosen exchange. Auto opens them, approved proposals fire them. Shorts stay paper."
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
                Each real order is sized by Risk per trade % of the account's spendable balance, risked between entry and stop — the same maths the paper desk uses. Set it under the live rules below.
              </p>
              <Field
                label="Live budget cap ($)"
                hint="The most exchange money real orders may put to work in total across all open positions. 0 means no limit."
              >
                <Input className="num" inputMode="decimal" value={live.live_cap_usd} onChange={setLiveNum('live_cap_usd')} />
              </Field>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Market orders only. Real fills are tracked separately from the paper balance, and a real position is closed by selling the same amount on the same account.
              </p>
            </div>
          ) : null}

          {sharedDeskFields(live, setLiveNum, setLiveV)}

          <Button className="w-full" onClick={saveLive} disabled={saving === 'live'}>
            {saving === 'live' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save live rules
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starting balance" hint="Your paper bankroll in USD.">
              <Input className="num" inputMode="decimal" value={paper.starting_balance} onChange={setPaperNum('starting_balance')} />
            </Field>
            <Field
              label="Profit handling"
              hint={
                paper.profit_mode === 'stack'
                  ? 'Profits are set aside and only the starting capital (plus losses) stays in the pool.'
                  : 'Booked profits roll back into the pool and grow future position sizes.'
              }
            >
              <Select value={paper.profit_mode} onValueChange={setPaperV('profit_mode')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compound">Compound profits</SelectItem>
                  <SelectItem value="stack">Stack profits aside</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {sharedDeskFields(paper, setPaperNum, setPaperV)}

          <Toggle
            label="Short trades"
            hint="Let the bot profit from breakdowns as well as breakouts. Real orders stay longs only."
            checked={paper.allow_shorts}
            onChange={setPaperV('allow_shorts')}
          />

          <Button className="w-full" onClick={savePaper} disabled={saving === 'paper'}>
            {saving === 'paper' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save paper rules
          </Button>
          <Button variant="outline" className="w-full border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={resetBalance} disabled={saving === 'paper'}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset paper stats
          </Button>
        </div>
      )}

      <div className="space-y-3 border-t border-border/60 pt-4">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Shared scan settings</p>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Both desks scan the same board with these — the per-desk rules above decide which setups each one takes.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Trading style">
            <Select value={shared.trading_style} onValueChange={setSharedV('trading_style')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="timid">Timid</SelectItem>
                <SelectItem value="mild">Mild</SelectItem>
                <SelectItem value="aggressive">Aggressive</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Scan timeframe">
            <Select value={shared.timeframe} onValueChange={setSharedV('timeframe')}>
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
          <Field label="Market coverage">
            <Select value={shared.market_cap_scope} onValueChange={setSharedV('market_cap_scope')}>
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
            label="Market tone watch"
            hint="Every full cycle re-reads the chart behind each open trade and closes ones the market has turned against."
            checked={shared.sentiment_watch}
            onChange={setSharedV('sentiment_watch')}
          />
          <Toggle
            label="Structure engine v2"
            hint="Adds Fibonacci pullback zones, Elliott wave counts and multi-touch support/resistance to scoring, with stale-breakout discounts. Turn off to revert to the previous engine."
            checked={shared.confluence_v2}
            onChange={setSharedV('confluence_v2')}
          />
          <Toggle
            label="Optimizer entry rules"
            hint="Structural entry rules: higher-timeframe confirmation, ADX 25 with the DI pair owned, 3 confluences, bounded stretch and no chasing. Turn off to revert to score-only entries."
            checked={shared.engine_v2}
            onChange={setSharedV('engine_v2')}
          />
          <Toggle
            label="Champion rules"
            hint="The optimizer champion's refinements: 2.5R targets, break-even after +1.2R, 1.5x volume, and longs only while BTC's tape is risk-off. Governs both desks; turn off to trade the base entry rules."
            checked={shared.champion_engine}
            onChange={setSharedV('champion_engine')}
          />
        </div>
        <Button className="w-full" onClick={saveShared} disabled={saving === 'shared'}>
          {saving === 'shared' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save shared settings
        </Button>
      </div>
    </div>
  );
}