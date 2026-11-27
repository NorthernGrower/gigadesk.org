import PaperRules from '@/components/bot/PaperRules';
import LiveRules from '@/components/bot/LiveRules';

// Each desk sees only its own rules, and each book on the desk only its own
// values: the dollar book shows the desk's rules, the Bitcoin book its own set.
// The books run the same trade logic and never share their values. The live
// panel also gets the account's Bitcoin and why no Bitcoin entry could fire,
// so the rules say what the book has to spend and what is blocking it.
export default function RiskSettings({
  config,
  onSaved,
  desk,
  book = 'USD',
  btcBook = null,
  btcRate = 0,
  btcBlocked = null,
}) {
  if (desk === 'live')
    return (
      <LiveRules
        config={config}
        onSaved={onSaved}
        book={book}
        btcBook={btcBook}
        btcRate={btcRate}
        btcBlocked={btcBlocked}
      />
    );
  return <PaperRules config={config} onSaved={onSaved} book={book} />;
}
