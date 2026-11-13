import React, { useState } from 'react';
import { Plus, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import { EXCHANGE_META, EXCHANGE_ORDER } from './meta';

const EMPTY = { exchange: 'binance_us', label: '', api_key: '', api_secret: '', passphrase: '', testnet: false, allow_trading: false };

export default function ConnectionForm({ onSaved }) {
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const meta = EXCHANGE_META[form.exchange];

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const res = await base44.functions.invoke('saveExchangeConnection', form);
      const data = res && res.data ? res.data : res;
      const conn = data.connection;
      if (data.account && data.account.ok) {
        toast({ title: `${conn.label} connected`, description: 'The key was verified against a live account read.' });
      } else {
        toast({
          title: 'Saved, but the exchange rejected this key',
          description: (data.account && data.account.message) || 'Check the connection card for details.',
          variant: 'destructive',
        });
      }
      setForm({ ...EMPTY, exchange: form.exchange });
      if (onSaved) onSaved(conn);
    } catch (err) {
      setError((err && err.message) || 'Could not save the connection.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="surface p-5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/30">
          <Plus className="h-4 w-4 text-primary" />
        </span>
        <div>
          <h3 className="font-heading text-sm font-semibold">Add a connection</h3>
          <p className="text-xs text-muted-foreground">Verified with a live account read before it is stored.</p>
        </div>
      </div>

      <div className="mt-4 grid gap-4">
        <div className="grid gap-1.5">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Exchange</Label>
          <Select value={form.exchange} onValueChange={(v) => set('exchange', v)} disabled={saving}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXCHANGE_ORDER.map((id) => (
                <SelectItem key={id} value={id}>
                  {EXCHANGE_META[id].name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{meta.note}</p>
        </div>

        <div className="grid gap-1.5">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Label</Label>
          <Input value={form.label} onChange={(e) => set('label', e.target.value)} placeholder={`${meta.name} main`} disabled={saving} />
        </div>

        <div className="grid gap-1.5">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">API key</Label>
          <Input value={form.api_key} onChange={(e) => set('api_key', e.target.value)} placeholder="API key" disabled={saving} autoComplete="off" />
        </div>

        <div className="grid gap-1.5">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">API secret</Label>
          <Input type="password" value={form.api_secret} onChange={(e) => set('api_secret', e.target.value)} placeholder="API secret" disabled={saving} autoComplete="new-password" />
        </div>

        {meta.needsPassphrase && (
          <div className="grid gap-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Passphrase</Label>
            <Input type="password" value={form.passphrase} onChange={(e) => set('passphrase', e.target.value)} placeholder="Passphrase" disabled={saving} autoComplete="new-password" />
            {meta.passphraseHint && <p className="text-xs text-muted-foreground">{meta.passphraseHint}</p>}
          </div>
        )}

        {meta.testnet && (
          <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
            <div>
              <p className="text-sm">Use testnet</p>
              <p className="text-xs text-muted-foreground">Signs against the venue&apos;s paper environment.</p>
            </div>
            <Switch checked={form.testnet} onCheckedChange={(v) => set('testnet', v)} disabled={saving} />
          </div>
        )}

        <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
          <div>
            <p className="flex items-center gap-1.5 text-sm">
              {form.allow_trading ? <ShieldAlert className="h-4 w-4 text-destructive" /> : <ShieldCheck className="h-4 w-4 text-primary" />}
              Allow live trading
            </p>
            <p className="text-xs text-muted-foreground">Stored on the connection; order placement is wired in a later step.</p>
          </div>
          <Switch checked={form.allow_trading} onCheckedChange={(v) => set('allow_trading', v)} disabled={saving} />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" disabled={saving || !form.api_key || !form.api_secret}>
          {saving ? 'Verifying with the exchange…' : 'Connect & verify'}
        </Button>
      </div>
    </form>
  );
}