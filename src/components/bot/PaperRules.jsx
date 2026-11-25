import React, { useEffect, useState } from 'react';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { roundTo } from '@/lib/market';
import { Field, ScoreBarField, Toggle, WarningsBox, deskRuleWarnings, riskFields, scanEngineFields, pyramidFields } from '@/components/bot/ruleFields';
// The margin engine is live-desk only — the paper panel never shows or saves it.

// The paper desk's own rules — nothing here touches the live desk.
export default function PaperRules({ config, onSaved }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(null);

  const fromConfig = (c) => ({
    starting_balance: c?.starting_balance ?? 10000,
    profit_mode: c?.profit_mode || 'compound',
    score_bar: c?.score_bar ?? 70,
    risk_per_trade_pct: c?.risk_per_trade_pct ?? 4,
    max_open_positions: c?.max_open_positions ?? 8,
    daily_target_pct: c?.daily_target_pct ?? 2,
    cooldown_minutes: c?.cooldown_minutes ?? 120,
    trailing_stop: c?.trailing_stop ?? true,
    trailing_trigger_pct: c?.trailing_trigger_pct ?? 3,
    trailing_distance_pct: c?.trailing_distance_pct ?? 1.5,
    allow_shorts: c?.allow_shorts ?? true,
    trading_style: c?.trading_style || 'mild',
    timeframe: c?.timeframe || '1h',
    market_cap_scope: c?.market_cap_scope || 'all',
    sentiment_watch: c?.sentiment_watch ?? true,
    confluence_v2: c?.confluence_v2 !== false,
    engine_v2: c?.engine_v2 !== false,
    champion_engine: c?.champion_engine !== false,
    btc_gate: c?.btc_gate !== false,
    max_trade_loss_pct: c?.max_trade_loss_pct ?? 20,
    pyramid: c?.pyramid === true,
    pyramid_trigger_pct: c?.pyramid_trigger_pct ?? 1.5,
    v3_algo: c?.v3_algo === true,
    always_take_top: c?.always_take_top === true,
    always_take_count: c?.always_take_count ?? 5,
    analyst_on: c?.analyst_on === true,
  });
  const [paper, setPaper] = useState(() => fromConfig(config));

  // re-sync the form whenever a fresh config lands (after a save or a cycle)
  useEffect(() => {
    if (config) setPaper(fromConfig(config));
  }, [config?.id, config?.updated_date]);

  const setPaperV = (key) => (value) => setPaper((prev) => ({ ...prev, [key]: value }));
  const setPaperNum = (key) => (event) => setPaper((prev) => ({ ...prev, [key]: event.target.value }));

  const savePaper = async () => {
    setSaving('paper');
    try {
      await base44.entities.BotConfig.update(config.id, {
        starting_balance: roundTo(paper.starting_balance, 2),
        profit_mode: paper.profit_mode,
        score_bar: Math.max(0, roundTo(Number(paper.score_bar), 1)),
        risk_per_trade_pct: roundTo(paper.risk_per_trade_pct, 2),
        max_open_positions: Math.max(1, Math.round(Number(paper.max_open_positions) || 1)),
        daily_target_pct: roundTo(paper.daily_target_pct, 2),
        target_pct: roundTo(paper.daily_target_pct, 2),
        cooldown_minutes: Math.max(0, Math.round(Number(paper.cooldown_minutes) || 0)),
        trailing_trigger_pct: roundTo(paper.trailing_trigger_pct, 2),
        trailing_distance_pct: roundTo(paper.trailing_distance_pct, 2),
        trailing_stop: paper.trailing_stop,
        allow_shorts: paper.allow_shorts,
        trading_style: paper.trading_style,
        timeframe: paper.timeframe,
        market_cap_scope: paper.market_cap_scope,
        sentiment_watch: paper.sentiment_watch,
        confluence_v2: paper.confluence_v2,
        engine_v2: paper.engine_v2,
        champion_engine: paper.champion_engine,
        btc_gate: paper.btc_gate,
        max_trade_loss_pct: roundTo(paper.max_trade_loss_pct, 1),
        pyramid: paper.pyramid === true,
        pyramid_trigger_pct: roundTo(Number(paper.pyramid_trigger_pct) || 1.5, 2),
        v3_algo: paper.v3_algo === true,
        always_take_top: paper.always_take_top === true,
        always_take_count: Math.max(1, Math.min(10, Math.round(Number(paper.always_take_count) || 5))),
        analyst_on: paper.analyst_on === true,
      });
      toast({ title: 'Paper rules saved', description: 'The paper desk picks them up on its next cycle. Live rules are untouched.' });
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

  return (
    <div className="surface space-y-4 p-4">
      <div>
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Paper bot rules</p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          These rules govern the paper desk only — the live desk keeps its own rules, saved separately.
        </p>
      </div>

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

      <ScoreBarField form={paper} setNum={setPaperNum} />

      {riskFields(paper, setPaperNum, setPaperV)}

      {pyramidFields(paper, setPaperNum, setPaperV)}

      <Toggle
        label="Short trades"
        hint="Let the paper bot profit from breakdowns as well as breakouts."
        checked={paper.allow_shorts}
        onChange={setPaperV('allow_shorts')}
      />

      {scanEngineFields(paper, setPaperNum, setPaperV)}

      <WarningsBox warnings={deskRuleWarnings(paper)} />

      <Button className="w-full" onClick={savePaper} disabled={saving === 'paper'}>
        {saving === 'paper' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
        Save paper rules
      </Button>
      <Button variant="outline" className="w-full border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={resetBalance} disabled={saving === 'paper'}>
        <RotateCcw className="mr-2 h-4 w-4" />
        Reset paper stats
      </Button>
    </div>
  );
}