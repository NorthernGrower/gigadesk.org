import PaperRules from '@/components/bot/PaperRules';
import LiveRules from '@/components/bot/LiveRules';

// Both desks' rules, each its own separate list: the paper desk saves its
// settings into the config itself, the live desk into live_rules — the two
// share nothing.
export default function RiskSettings({ config, onSaved }) {
  return (
    <div className="space-y-4">
      <PaperRules config={config} onSaved={onSaved} />
      <LiveRules config={config} onSaved={onSaved} />
    </div>
  );
}