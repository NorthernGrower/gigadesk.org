import React from 'react';
import LiveRules from '@/components/bot/LiveRules';
import PaperRules from '@/components/bot/PaperRules';

// The rules panel follows the active desk: the live desk shows and saves its
// own rules (live_rules), the paper desk its own (the config itself) — the
// two share nothing.
export default function RiskSettings({ config, onSaved }) {
  const desk = config?.active_desk === 'live' ? 'live' : 'paper';
  return desk === 'live' ? (
    <LiveRules config={config} onSaved={onSaved} />
  ) : (
    <PaperRules config={config} onSaved={onSaved} />
  );
}