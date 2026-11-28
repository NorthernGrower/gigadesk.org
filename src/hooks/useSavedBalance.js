import { useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';

// The desk-side balance mechanism, shared by the Live Desk and the Bot page:
// the connection's saved balance is re-read from the exchange via
// checkExchangeConnection every minute, so a figure stays on screen even when
// a bot cycle skips (or fails) its own live read. An errored connection is
// never re-polled — Kraken counts failed signed reads toward its lockout.
export default function useSavedBalance(connectionId, status) {
  const [savedBalance, setSavedBalance] = useState(null);
  const statusRef = useRef(status);
  const backoffRef = useRef(0);
  statusRef.current = status;

  useEffect(() => {
    if (!connectionId) return undefined;
    let alive = true;
    const check = async () => {
      if (statusRef.current && statusRef.current !== 'connected') return;
      // a failed read backs the key off exchange-side; retrying during the
      // backoff keeps the lockout alive, so the desk waits it out
      if (backoffRef.current && Date.now() < backoffRef.current) return;
      try {
        const res = await base44.functions.invoke('checkExchangeConnection', { id: connectionId });
        const conn = res.data?.connection;
        if (conn?.backoff_until) backoffRef.current = Date.parse(conn.backoff_until);
        if (alive && conn) {
          const btcRow = (conn.balances || []).find((b) => String(b.asset || '').toUpperCase() === 'BTC');
          setSavedBalance((prev) => ({
            usd: conn.balance_usd ?? prev?.usd ?? null,
            // the exchange's Bitcoin holding stays on screen even when a bot
            // cycle skips its own read: without it the live BTC desk fell to 0
            btc: btcRow ? Number(btcRow.total) || 0 : prev?.btc ?? null,
            asOf: conn.balance_updated_at || prev?.asOf || null,
          }));
        }
      } catch {
        // a failed check keeps the last saved figure
      }
    };
    check();
    const timer = setInterval(check, 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [connectionId]);

  return savedBalance;
}