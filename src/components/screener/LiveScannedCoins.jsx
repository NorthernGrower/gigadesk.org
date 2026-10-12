import React, { useEffect, useState } from 'react';
import ScannedCoins from '@/components/desk/ScannedCoins';
import { runBot } from '@/lib/market';

/**
 * The scanner's scanned-coins list: the ranked results of the bot's latest
 * full market scan, refreshed live as new cycles finish.
 */
export default function LiveScannedCoins() {
  const [rows, setRows] = useState([]);
  const [scanned, setScanned] = useState(null);

  useEffect(() => {
    let alive = true;
    // a fresh full cycle on entry gives the newest ranked list
    runBot(false)
      .then((data) => {
        if (!alive || !data) return;
        setRows(data.top || []);
        setScanned(data.scanned ?? null);
      })
      .catch(() => {});
    // every later cycle updates the list in place
    const onTick = (event) => {
      const data = event.detail;
      if (!alive || !data) return;
      if (data.top?.length) setRows(data.top);
      if (data.scanned) setScanned(data.scanned);
    };
    window.addEventListener('bot:tick', onTick);
    return () => {
      alive = false;
      window.removeEventListener('bot:tick', onTick);
    };
  }, []);

  return <ScannedCoins rows={rows} scannedCount={scanned} />;
}