import React, { useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw, Save } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { pageItems, roundTo } from '@/lib/market';
import { fmtUsd } from '@/lib/format';
import { bookRuleKeys, bookRuleSet } from '@/lib/bookRules';
import { Field, ScoreBarField, Toggle, WarningsBox, deskRuleWarnings, riskFields, scanEngineFields, pyramidFields, BtcBalanceNote } from '@/components/bot/ruleFields';
// The margin engine is live-desk only — the paper panel never shows or saves it.

// Each desk has a paper rules panel for each book. The books share the engine
// and the trade logic, but save their values separately: the dollar book into
// the config, the Bitcoin book into btc_rules.
export default function PaperRules({ config, onSaved, book = 'USD', btcBook = null, btcRate = 0, dominance = null }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(null);
  const isBtc = book === 'BTC';

  const fromConfig = (c) => {
    const view = bookRuleSet(c, 'paper', book);
    return {
      starting_btc: isBtc ? c?.btc_starting_btc ?? 0 : 0,
      starting_balance: isBtc ? c?.btc_starting_balance ?? 10000 : c?.starting_balance ?? 10000,
      profit_mode: view.profit_mode || 'compound',
      score_bar: view.score_bar ?? 70,
      risk_per_trade_pct: view.risk_per_trade_pct ?? 4,
      max_open_positions: view.max_open_positions ?? 8,
      daily_target_pct: view.daily_target_pct ?? 2,
      cooldown_minutes: view.cooldown_minutes ?? 120,
      trailing_stop: view.trailing_stop ?? true,
      trailing_trigger_pct: view.trailing_trigger_pct ?? 3,
      trailing_distance_pct: view.trailing_distance_pct ?? 1.5,
      allow_shorts: view.allow_shorts ?? true,
      trading_style: view.trading_style || 'mild',
      timeframe: view.timeframe || '1h',
      market_cap_scope: view.market_cap_scope || 'all',
      sentiment_watch: view.sentiment_watch ?? true,
      confluence_v2: view.confluence_v2 !== false,
      engine_v2: view.engine_v2 !== false,
      champion_engine: view.champion_engine !== false,
      btc_gate: view.btc_gate !== false,
      max_trade_loss_pct: view.max_trade_loss_pct ?? 20,
      pyramid: view.pyramid === true,
      pyramid_trigger_pct: view.pyramid_trigger_pct ?? 1.5,
      v3_algo: view.v3_algo === true,
      always_take_top: view.always_take_top === true,
      always_take_count: view.always_take_count ?? 5,
      analyst_on: view.analyst_on === true,
      btc_markets: view.btc_markets === true,
      v3_exit: view.v3_exit === true,
      harmonics: view.harmonics === true,
      dominance: view.dominance ?? true,
    };
  };
  const [paper, setPaper] = useState(() => fromConfig(config));

  // the form is loaded once per desk and book, never on every background poll:
  // a cycle that lands while the user is editing must not put the old values
  // back. A different config row or the other book still reloads it.
  const syncedFor = useRef('');
  useEffect(() => {
    if (!config) return;
    const key = `${config.id || ''}:${isBtc ? 'BTC' : 'USD'}`;
    if (syncedFor.current === key) return;
    syncedFor.current = key;
    setPaper(fromConfig(config));
  }, [config, isBtc]);

  const setPaperV = (key) => (value) => setPaper((prev) => ({ ...prev, [key]: value }));
  const setPaperNum = (key) => (event) => setPaper((prev) => ({ ...prev, [key]: event.target.value }));

  // the values shared by both books, normalised exactly as the panel shows them
  const values = () => ({
    profit_mode: paper.profit_mode,
    score_bar: Math.max(0, roundTo(Number(paper.score_bar), 1)),
    risk_per_trade_pct: roundTo(paper.risk_per_trade_pct, 2),
    max_open_positions: Math.max(1, Math.round(Number(paper.max_open_positions) || 1)),
    daily_target_pct: roundTo(paper.daily_target_pct, 2),
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
    btc_markets: paper.btc_markets === true,
    v3_exit: paper.v3_exit === true,
    harmonics: paper.harmonics === true,
    dominance: paper.dominance !== false,
  });

  // only this book's keys are written; the other book's set is never touched.
  // The switches that belong to the whole desk (the BTC markets switch and the
  // desk analyst) stay at the desk level, so both book panels see the same one.
  const DESK_KEYS = ['btc_markets', 'analyst_on'];
  const pick = (keys, source) =>
    Object.fromEntries(
      keys.filter((key) => !DESK_KEYS.includes(key) && source[key] != null).map((key) => [key, source[key]]),
    );

  const savePaper = async () => {
    setSaving('paper');
    try {
      const all = values();
      if (isBtc) {
        const saved = pick(bookRuleKeys('paper', 'BTC'), all);
        saved.starting_balance = roundTo(paper.starting_balance, 2);
        saved.profit_mode = paper.profit_mode;
        // the BTC bankroll is the rule: price it once here so the cash the book
        // spends and the cash the desk shows agree with the number just entered.
        // With positions still open the cash is left alone — a reset is the
        // explicit way to re-anchor a book that is mid-trade.
        const startBtc = Number(paper.starting_btc) > 0 ? Number(paper.starting_btc) : 0;
        const startUsd =
          startBtc > 0 && Number(btcRate) > 0 ? startBtc * Number(btcRate) : roundTo(paper.starting_balance, 2);
        let noOpenBtc = false;
        try {
          const open = await base44.entities.Trade.filter(
            { mode: 'paper', status: 'open', quote_asset: 'BTC' },
            { limit: 1 },
          );
          noOpenBtc = pageItems(open).length === 0;
        } catch {
          // unknown: leave the cash untouched rather than re-anchor blind
        }
        await base44.entities.BotConfig.update(config.id, {
          btc_rules: { ...(config.btc_rules || {}), ...saved },
          // the book's bankroll and the desk-level switches both live on the config
          btc_starting_btc: roundTo(startBtc, 8),
          btc_starting_balance: roundTo(startUsd, 2),
          ...(noOpenBtc && startBtc > 0 && Number(btcRate) > 0
            ? { btc_cash_balance: roundTo(startUsd, 2) }
            : {}),
          btc_markets: paper.btc_markets === true,
          analyst_on: paper.analyst_on === true,
        });
      } else {
        const saved = pick(bookRuleKeys('paper', 'USD'), all);
        await base44.entities.BotConfig.update(config.id, {
          ...saved,
          starting_balance: roundTo(paper.starting_balance, 2),
          target_pct: roundTo(paper.daily_target_pct, 2),
          btc_markets: paper.btc_markets === true,
          analyst_on: paper.analyst_on === true,
        });
      }
      toast({ title: `${isBtc ? 'Bitcoin' : 'Dollar'} paper rules saved`, description: 'The other book’s rules are untouched.' });
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
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Paper bot rules · {isBtc ? 'Bitcoin book' : 'Dollar book'}
        </p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          These rules govern this paper book only — the other book and the live desk keep their own saved values. Both books run the same trade logic.
        </p>
      </div>

      {/* the account's Bitcoin is what the live Bitcoin book spends; it is shown
          here too, so a paper Bitcoin book never leaves the holding a mystery */}
      {isBtc ? (
        <BtcBalanceNote
          book={btcBook}
          rate={btcRate}
          note="The account's Bitcoin funds the live Bitcoin book only — this paper book trades the bankroll below."
        />
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        {isBtc ? (
          <Field label="Starting bankroll (BTC)" hint="Your paper Bitcoin book's bankroll in bitcoin. The desk translates it at the live BTC rate to size its trades; the dollar value below moves with BTC.">
            <Input className="num" inputMode="decimal" value={paper.starting_btc} onChange={setPaperNum('starting_btc')} />
            <p className="num text-[11px] text-muted-foreground">
              {Number(paper.starting_btc) > 0 && btcRate > 0
                ? `${fmtUsd(Number(paper.starting_btc) * btcRate)} at ${fmtUsd(btcRate)}/BTC`
                : 'Enter an amount to see its dollar value.'}
            </p>
          </Field>
        ) : null}
        <Field label={isBtc ? 'Fallback bankroll (USD)' : 'Starting balance'} hint={isBtc ? 'Used only when no BTC amount is set above.' : 'Your paper bankroll in USD.'}>
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

      {scanEngineFields(paper, setPaperNum, setPaperV, dominance)}

      <WarningsBox warnings={deskRuleWarnings(paper)} />

      <Button className="w-full" onClick={savePaper} disabled={saving === 'paper'}>
        {saving === 'paper' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
        Save {isBtc ? 'Bitcoin' : 'dollar'} paper rules
      </Button>
      <Button variant="outline" className="w-full border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={resetBalance} disabled={saving === 'paper'}>
        <RotateCcw className="mr-2 h-4 w-4" />
        Reset paper stats
      </Button>
    </div>
  );
}
