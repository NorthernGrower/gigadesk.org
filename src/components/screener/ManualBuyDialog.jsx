import React, { useState } from 'react';
import { Loader2, ShoppingBag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { manualBuy } from '@/lib/market';
import { useToast } from '@/components/ui/use-toast';
import { fmtPrice } from '@/lib/format';

// A manual buy from the scanner: a real market order on the connected
// exchange, opened in manual mode — the desk leaves the trade alone until
// bot handling is turned on for it.
export default function ManualBuyDialog({ row, defaultUsd = 100, onClose }) {
  const { toast } = useToast();
  const [usd, setUsd] = useState(String(defaultUsd));
  const [busy, setBusy] = useState(false);
  if (!row) return null;

  const buy = async () => {
    setBusy(true);
    try {
      await manualBuy({ symbol: row.symbol, usd: Number(usd) });
      toast({
        title: `Bought ${row.symbol} on the exchange`,
        description: 'Manual mode is on — the desk leaves this trade alone until you turn bot handling on. It shows under open positions.',
      });
      onClose(true);
    } catch (err) {
      toast({ title: 'The buy did not go through', description: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(false); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">Manual buy — {row.symbol}</DialogTitle>
          <DialogDescription>
            A real market order on your connected exchange at the live price. Manual buys skip the bot's entry gates — no BTC gate, no score bar — and open in manual mode.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-border/60 bg-secondary/25 px-3 py-2.5">
            <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Live price</span>
            <span className="num text-sm">{fmtPrice(row.price)}</span>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Amount (USD)</label>
            <Input
              type="number"
              min="10"
              value={usd}
              onChange={(event) => setUsd(event.target.value)}
              className="num mt-1"
              disabled={busy}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">The exchange sets a minimum per order — usually $10 or more.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={buy} disabled={busy || !(Number(usd) >= 10)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingBag className="h-4 w-4" />}
            Buy {row.symbol}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}