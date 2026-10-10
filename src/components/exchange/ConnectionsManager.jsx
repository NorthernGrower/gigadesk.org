import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useToast } from '@/components/ui/use-toast';
import ConnectionForm from './ConnectionForm';
import ConnectionCard from './ConnectionCard';

const SAFE_FIELDS = ['exchange', 'label', 'key_hint', 'testnet', 'allow_trading', 'status', 'status_message', 'can_trade', 'last_checked_at', 'balances'];

export default function ConnectionsManager({ showSafety = false }) {
  const { toast } = useToast();
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const page = await base44.entities.ExchangeConnection.filter({}, { sort: '-created_date', limit: 50, fields: SAFE_FIELDS });
      setConnections(page.items || []);
      setError('');
    } catch (e) {
      setError((e && e.message) || 'Could not load your connections.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const upsert = (conn) => {
    if (!conn) return;
    setConnections((list) => [conn, ...list.filter((c) => c.id !== conn.id)]);
  };

  const handleCheck = async (conn) => {
    setBusyId(conn.id);
    try {
      const res = await base44.functions.invoke('checkExchangeConnection', { id: conn.id });
      const data = res && res.data ? res.data : res;
      upsert(data.connection);
      toast({
        title: data.account && data.account.ok ? 'Connection verified' : 'Check failed',
        description: (data.account && data.account.message) || '',
      });
    } catch (e) {
      toast({ title: 'Check failed', description: (e && e.message) || '', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (conn) => {
    setBusyId(conn.id);
    try {
      await base44.entities.ExchangeConnection.delete(conn.id);
      setConnections((list) => list.filter((c) => c.id !== conn.id));
      toast({ title: `${conn.label || 'Connection'} removed` });
    } catch (e) {
      toast({ title: 'Could not remove the connection', description: (e && e.message) || '', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[380px_1fr]">
      <div className="grid gap-5">
        <ConnectionForm onSaved={upsert} />
        {showSafety && (
          <div className="surface p-5">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/30">
                <ShieldCheck className="h-4 w-4 text-primary" />
              </span>
              <h3 className="font-heading text-sm font-semibold">Key safety</h3>
            </div>
            <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
              <li>• Create keys with withdrawals disabled and, where offered, an IP allowlist.</li>
              <li>• Credentials are scoped to your account and are never shown again after saving.</li>
              <li>• Live trading stays off until you switch it on for a connection.</li>
              <li>• Execution is not wired yet — nothing places orders from this page today.</li>
            </ul>
          </div>
        )}
      </div>

      <div className="grid gap-4">
        {loading ? (
          <div className="surface grid min-h-40 place-items-center text-sm text-muted-foreground">Loading connections…</div>
        ) : error ? (
          <div className="surface p-6 text-sm text-destructive">{error}</div>
        ) : connections.length === 0 ? (
          <div className="surface grid min-h-40 place-items-center p-6 text-center text-sm text-muted-foreground">
            No connections yet. Add an exchange key to get started.
          </div>
        ) : (
          connections.map((conn) => (
            <ConnectionCard key={conn.id} conn={conn} busy={busyId === conn.id} onCheck={handleCheck} onRemove={handleRemove} />
          ))
        )}
      </div>
    </div>
  );
}