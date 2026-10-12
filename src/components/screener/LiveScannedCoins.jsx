import React, { useEffect, useState } from 'react';
import ScannedCoins from '@/components/desk/ScannedCoins';
import { runBot } from '@/lib/market';
import { pageItems } from '@/lib/market';
import { base44 } from '@/api/base44Client';

/**
 * The scanner's scanned-coins list: the ranked results of the bot's latest
 * full market scan. It opens with the stored setups from the last scan, then
 * refreshes live as new cycles finish.
 */
export default function LiveScannedCoins() {
  const [rows, setRows] = useState([]);
  const [scanned, setScanned] = useState(null);

  useEffect(() => {
    let alive = true;

    // stored setups from the last scan rank the list instantly, before the
    // first cycle of this visit has finished
    base44.entities.Signal
      .filter({ status: 'new' }, { sort: '-score', limit: 12 })
      .then((page) => {
        if (alive) setRows(pageItems(page));
      })
      .catch(() => {});

    // a full cycle whose scan was skipped (another one is already running)
    // reports zero scanned coins — that is not a real empty result, so the
    // previous list stays until a scan that actually ran answers
    const applyScan = (data) => {
      if (data.top?.length || data.scanned > 0) {
        setRows(data.top || []);
        setScanned(data.scanned ?? null);
      }
    };
    runBot(false)
      .then((data) => {
        if (alive && data) applyScan(data);
      })
      .catch(() => {});
    // every later cycle updates the list in place
    const onTick = (event) => {
      const data = event.detail;
      if (alive && data) applyScan(data);
    };
    window.addEventListener('bot:tick', onTick);
    return () => {
      alive = false;
      window.removeEventListener('bot:tick', onTick);
    };
  }, []);

  return <ScannedCoins rows={rows} scannedCount={scanned} />;
}