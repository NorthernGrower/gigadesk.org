import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { TIMEFRAMES, TIERS } from '@/lib/market';

export function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Toggle({ label, hint, checked, onChange }) {
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

export function WarningsBox({ warnings }) {
  if (!warnings.length) return null;
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-400">Trading blocker check</p>
      <ul className="mt-1.5 space-y-1.5">
        {warnings.map((text, i) => (
          <li key={i} className="text-[11px] leading-snug text-amber-200/90">{text}</li>
        ))}
      </ul>
    </div>
  );
}

// The coin score the engine trades at: a dropdown with 70 — the backtested
// most profitable bar — as its default, plus an inline warning the moment
// any other number is picked.
export function ScoreBarField({ form, setNum }) {
  const value = Number(form.score_bar);
  const options = Array.from(new Set([40, 50, 55, 60, 65, 70, 75, 80, value]))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return (
    <Field
      label="Entry score bar"
      hint="The minimum coin score the engine trades. 70 is the default."
    >
      <Select
        value={String(Number.isFinite(value) ? value : 70)}
        onValueChange={(v) => setNum('score_bar')({ target: { value: v } })}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((n) => (
            <SelectItem key={n} value={String(n)}>
              {n === 70 ? '70 (backtested optimum)' : String(n)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {Number.isFinite(value) && value !== 70 ? (
        <p className="text-[11px] leading-snug text-amber-400">
          Warning: 70 is the backtested most profitable score bar. Picking {value} takes more trades with weaker setups.
        </p>
      ) : null}
    </Field>
  );
}

// Entry gates are managed by the bot; only user-controlled risk is warned here.
export function deskRuleWarnings(rules) {
  const w = [];
  if ((Number(rules.risk_per_trade_pct) || 0) > 15)
    w.push(`Risk per trade ${rules.risk_per_trade_pct}% is very high — a short run of stops can halve the desk.`);
  if (rules.score_bar != null && Number(rules.score_bar) !== 70)
    w.push(`Score bar ${Number(rules.score_bar)} differs from the tested optimum of 70: the backtested champion (77.8% win rate, profit factor 23.6 over 6 months) only traded score-70+ setups. Lower bars take more trades with weaker setups.`);
  if (rules.champion_engine !== false && rules.btc_gate === false)
    w.push('Warning: the BTC regime gate is off. It is part of the backtested champion stack, so turning it off can reduce profitability — longs will trade in any BTC tape, including risk-on ones the champion skipped.');
  return w;
}

// The risk and slot fields every desk sets in its own panel.
export function riskFields(form, setNum, set) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Risk per trade %" hint="Share of the balance risked between entry and stop.">
        <Input className="num" inputMode="decimal" value={form.risk_per_trade_pct} onChange={setNum('risk_per_trade_pct')} />
      </Field>
      <Field label="Max open positions">
        <Input className="num" inputMode="numeric" value={form.max_open_positions} onChange={setNum('max_open_positions')} />
      </Field>
      <Field label="Daily target %" hint="Your daily progress goal. It does not block new entries.">
        <Input className="num" inputMode="decimal" value={form.daily_target_pct} onChange={setNum('daily_target_pct')} />
      </Field>
      <Field label="Cooldown (minutes)" hint="How long a coin is left alone after a trade closes.">
        <Input className="num" inputMode="numeric" value={form.cooldown_minutes} onChange={setNum('cooldown_minutes')} />
      </Field>
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

// The per-desk scan and engine settings: trading style, timeframe, market
// coverage, tone watch and the engine toggles — each desk keeps its own.
export function scanEngineFields(form, setNum, setV) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Trading style" hint="Timid picks stronger setups with smaller risk; aggressive takes more, bigger trades.">
          <Select value={form.trading_style} onValueChange={setV('trading_style')}>
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
          <Select value={form.timeframe} onValueChange={setV('timeframe')}>
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
          <Select value={form.market_cap_scope} onValueChange={setV('market_cap_scope')}>
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
      <Field
        label="Max loss per trade %"
        hint="The most one trade can lose, as a percent of what is deployed in it. A trade down this far is closed at market on the next bot cycle, even if its stop has not fired. 0 turns the guard off."
      >
        <Input className="num" inputMode="decimal" value={form.max_trade_loss_pct} onChange={setNum('max_trade_loss_pct')} />
      </Field>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Toggle
          label="Market tone watch"
          hint="Every full cycle re-reads the chart behind each open trade on this desk and closes ones the market has turned against."
          checked={form.sentiment_watch}
          onChange={setV('sentiment_watch')}
        />
        <Toggle
          label="Structure engine v2"
          hint="Adds Fibonacci pullback zones, Elliott wave counts and multi-touch support/resistance to scoring, with stale-breakout discounts. Turn off to revert to the previous engine."
          checked={form.confluence_v2}
          onChange={setV('confluence_v2')}
        />
        <Toggle
          label="Champion rules"
          hint="Keeps the champion target and break-even management. Entry quality is managed automatically, without a BTC-regime or volume-spike veto."
          checked={form.champion_engine}
          onChange={setV('champion_engine')}
        />
        {form.champion_engine ? (
          <Toggle
            label="BTC regime gate"
            hint="The champion engine's tested tape filter: longs only open while BTC's 24h move is risk-off (under -1%). Turn off to let longs trade in any tape."
            checked={form.btc_gate}
            onChange={setV('btc_gate')}
          />
        ) : null}
        <Toggle
          label="Margin engine"
          hint="The optimizer's Kraken-margin stack: 3R targets, 50% conviction candles, majors + AVAX only. Gains and losses both move faster."
          checked={form.margin_engine}
          onChange={setV('margin_engine')}
        />
      </div>
      {form.margin_engine ? (
        <div className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-destructive">Margin engine warning</p>
          <p className="text-[11px] leading-snug text-destructive/90">
            Margin trades lose money faster: positions are leveraged, so a stop-out takes a bigger bite of the account than a spot trade, and the tighter 3R targets book losses sooner too. Only enable it with money you can afford to lose.
          </p>
          <Field label="Margin leverage" hint="Leverage shorts open at on Kraken (1-5); gains and losses both scale with it.">
            <Input className="num" inputMode="numeric" value={form.margin_leverage} onChange={setNum('margin_leverage')} />
          </Field>
        </div>
      ) : null}
    </>
  );
}