import PaperRules from '@/components/bot/PaperRules';
import LiveRules from '@/components/bot/LiveRules';

// Each desk sees only its own rules: the paper desk saves its settings into
  // the config itself, the live desk into live_rules — the two share nothing.
export default function RiskSettings({ config, onSaved, desk }) {
  if (desk === 'live') return <LiveRules config={config} onSaved={onSaved} />;
  return <PaperRules config={config} onSaved={onSaved} />;
}