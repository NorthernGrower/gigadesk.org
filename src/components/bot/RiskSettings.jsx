import PaperRules from '@/components/bot/PaperRules';
import LiveRules from '@/components/bot/LiveRules';

// Each desk sees only its own rules, and each book on the desk only its own
// values: the dollar book shows the desk's rules, the Bitcoin book its own set.
// The books run the same trade logic and never share their values.
export default function RiskSettings({ config, onSaved, desk, book = 'USD' }) {
  if (desk === 'live') return <LiveRules config={config} onSaved={onSaved} book={book} />;
  return <PaperRules config={config} onSaved={onSaved} book={book} />;
}
