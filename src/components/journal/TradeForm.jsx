import React, { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { roundTo } from '@/lib/market';

const BLANK = {
  symbol: '',
  side: 'long',
  entry_price: '',
  exit_price: '',
  size_usd: '',
  fees_usd: '',
  opened_at: '',
  closed_at: '',
  notes: '',
};

function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

export default function TradeForm({ onSaved }) {
  const { toast } = useToast();
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);

  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
  const setValue = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    const symbol = form.symbol.trim().toUpperCase();
    const entry = Number(form.entry_price);
    const size = Number(form.size_usd);
    const exit = Number(form.exit_price);
    if (!symbol || !(entry > 0) || !(size > 0)) {
      toast({ title: 'Symbol, entry price and size are required', variant: 'destructive' });
      return;
    }

    const closed = exit > 0;
    const quantity = size / entry;
    const fees = Number(form.fees_usd) || 0;
    const gross = form.side === 'short' ? (entry - (closed ? exit : entry)) * quantity : ((closed ? exit : entry) - entry) * quantity;
    const pnl = closed ? gross - fees : 0;

    setSaving(true);
    try {
      await base44.entities.Trade.create({
        symbol,
        name: symbol,
        side: form.side,
        mode: 'real',
        status: closed ? 'closed' : 'open',
        entry_price: roundTo(entry, 6),
        quantity: roundTo(quantity, 6),
        size_usd: roundTo(size, 2),
        exit_price: closed ? roundTo(exit, 6) : undefined,
        fees_usd: roundTo(fees, 2),
        pnl_usd: closed ? roundTo(pnl, 2) : undefined,
        pnl_pct: closed ? roundTo((pnl / size) * 100, 2) : undefined,
        exit_reason: closed ? 'manual' : undefined,
        opened_at: form.opened_at ? new Date(form.opened_at).toISOString() : new Date().toISOString(),
        closed_at: closed ? new Date(form.closed_at || Date.now()).toISOString() : undefined,
        notes: form.notes || '',
      });
      toast({
        title: closed ? `Logged ${symbol} with ${pnl >= 0 ? 'a profit' : 'a loss'}` : `Logged your open ${symbol} position`,
        description: 'Real fills are tracked separately from the paper balance.',
      });
      setForm(BLANK);
      if (onSaved) onSaved();
    } catch (error) {
      toast({ title: 'Could not log the trade', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="surface space-y-4 p-4">
      <div>
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Log a real fill</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Record trades you place on your own exchange. Leave the exit price empty for a position that is still open.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Symbol">
          <Input
            className="font-display uppercase"
            placeholder="BTC"
            value={form.symbol}
            onChange={set('symbol')}
          />
        </Field>
        <Field label="Direction">
          <Select value={form.side} onValueChange={setValue('side')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="long">Long</SelectItem>
              <SelectItem value="short">Short</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Entry price">
          <Input className="num" inputMode="decimal" value={form.entry_price} onChange={set('entry_price')} />
        </Field>
        <Field label="Size (USD)">
          <Input className="num" inputMode="decimal" value={form.size_usd} onChange={set('size_usd')} />
        </Field>
        <Field label="Exit price">
          <Input className="num" inputMode="decimal" placeholder="leave empty if open" value={form.exit_price} onChange={set('exit_price')} />
        </Field>
        <Field label="Fees (USD)">
          <Input className="num" inputMode="decimal" value={form.fees_usd} onChange={set('fees_usd')} />
        </Field>
      </div>

      <Field label="Notes">
        <Input placeholder="Why you took it, how you managed it" value={form.notes} onChange={set('notes')} />
      </Field>

      <Button className="w-full" onClick={submit} disabled={saving}>
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
        Log the trade
      </Button>
    </div>
  );
}