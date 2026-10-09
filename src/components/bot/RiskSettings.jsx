import React, { useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/use-toast';
import { TIMEFRAMES, TIERS, roundTo } from '@/lib/market';

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
    starting_balance: config?.starting_balance ?? 10000,
    risk_per_trade_pct: config?.risk_per_trade_pct ?? 4,
    max_open_positions: config?.max_open_positions ?? 8,
    daily_target_pct: config?.daily_target_pct ?? 2,
    min_score: config?.min_score ?? 62,
    cooldown_minutes: config?.cooldown_minutes ?? 120,
    trailing_trigger_pct: config?.trailing_trigger_pct ?? 1,
    trailing_distance_pct: config?.trailing_distance_pct ?? 1.5,
    trailing_stop: config?.trailing_stop ?? true,
    allow_shorts: config?.allow_shorts ?? true,
    require_daily_target: config?.require_daily_target ?? true,
    auto_run: config?.auto_run ?? true,
    timeframe: config?.timeframe || '1h',
    market_cap_scope: config?.market_cap_scope || 'all',
  });
  const [saving, setSaving] = useState(false);

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));
  const setNum = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      await base44.entities.BotConfig.update(config.id, {
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
        timeframe: form.timeframe,
        market_cap_scope: form.market_cap_scope,
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
      </div>

      {form.trailing_stop ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Trail after %">
            <Input className="num" inputMode="decimal" value={form.trailing_trigger_pct} onChange={setNum('trailing_trigger_pct')} />
          </Field>
          <Field label="Trail distance %">
            <Input className="num" inputMode="decimal" value={form.trailing_distance_pct} onChange={setNum('trailing_distance_pct')} />
          </Field>
        </div>
      ) : null}

      <Button className="w-full" onClick={save} disabled={saving}>
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
        Save risk rules
      </Button>
    </div>
  );
}