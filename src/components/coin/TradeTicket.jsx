import React, { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';
import { ensureBotConfig, emitBotTick, roundTo } from '@/lib/market';
import { fmtPrice, fmtUsd } from '@/lib/format';

export default function TradeTicket({ snapshot, onOpened }) {
  const { toast } = useToast();
  const [side, setSide] = useState(snapshot?.side || 'long');
  const [size, setSize] = useState('1000');
  const [busy, setBusy] = useState(false);

  if (!snapshot) return null;

  const entry = snapshot.entry;
  const riskDistance = Math.abs(snapshot.entry - snapshot.stop) || snapshot.entry * 0.025;
  const flipped = side !== snapshot.side;
  const stop = flipped
    ? side === 'long'
      ? entry - riskDistance
      : entry + riskDistance
    : snapshot.stop;
  const target = flipped
    ? side === 'long'
      ? entry + riskDistance * 2.5
      : entry - riskDistance * 2.5
    : snapshot.target;
  const risk = Math.abs(entry - stop);
  const sizeNum = Number(size) || 0;
  const qty = risk > 0 ? sizeNum / entry : 0;
  const riskUsd = qty * risk;

  const submit = async () => {
    if (!(sizeNum > 0)) {
      toast({ title: 'Enter a position size', variant: 'destructive' });
      return;
    }
    setBusy(true);
    try {
      const config = await ensureBotConfig();
      if (sizeNum > Number(config.cash_balance || 0)) {
        toast({
          title: 'Not enough paper balance',
          description: `Available ${fmtUsd(config.cash_balance)}`,
          variant: 'destructive',
        });
        setBusy(false);
        return;
      }
      await base44.entities.Trade.create({
        symbol: snapshot.symbol,
        name: snapshot.name,
        side,
        mode: 'paper',
        status: 'open',
        entry_price: entry,
        quantity: roundTo(qty, 4),
        size_usd: roundTo(sizeNum, 2),
        stop_price: stop,
        target_price: target,
        peak_price: entry,
        score: snapshot.score,
        rationale: (snapshot.reasons || []).join(' • '),
        notes: 'Opened manually from the chart',
        opened_at: new Date().toISOString(),
      });
      await base44.entities.BotConfig.update(config.id, {
        cash_balance: roundTo(Number(config.cash_balance || 0) - sizeNum, 2),
      });
      toast({
        title: `${side === 'long' ? 'Long' : 'Short'} opened on ${snapshot.symbol}`,
        description: `${fmtUsd(sizeNum)} at ${fmtPrice(entry)}`,
      });
      emitBotTick({ manualOpen: true });
      if (onOpened) onOpened();
    } catch (error) {
      toast({ title: 'Could not open the position', description: error.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="surface space-y-3 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Manual buy</p>
        <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-secondary/40 p-0.5">
          <button
            type="button"
            onClick={() => setSide('long')}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] ${
              side === 'long' ? 'bg-primary/15 text-primary ring-1 ring-primary/30' : 'text-muted-foreground'
            }`}
          >
            <ArrowUpRight className="h-3.5 w-3.5" /> Long
          </button>
          <button
            type="button"
            onClick={() => setSide('short')}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] ${
              side === 'short' ? 'bg-destructive/15 text-destructive ring-1 ring-destructive/30' : 'text-muted-foreground'
            }`}
          >
            <ArrowDownRight className="h-3.5 w-3.5" /> Short
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 text-xs">
        <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Entry</p>
          <p className="num mt-0.5 text-sm">{fmtPrice(entry)}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Stop</p>
          <p className="num mt-0.5 text-sm text-destructive">{fmtPrice(stop)}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Target</p>
          <p className="num mt-0.5 text-sm text-primary">{fmtPrice(target)}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-secondary/25 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Risk at stop</p>
          <p className="num mt-0.5 text-sm">{fmtUsd(riskUsd)}</p>
        </div>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Position size (USD)</label>
          <Input
            className="num mt-1"
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </div>
        <Button onClick={submit} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Open position'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {qty ? `${qty.toFixed(4)} units · ` : ''}tracked against your paper balance, closed automatically at the stop
        or target.
      </p>
    </div>
  );
}