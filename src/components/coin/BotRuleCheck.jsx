import React from 'react';
import { CheckCircle2, MinusCircle } from 'lucide-react';

export default function BotRuleCheck({ snapshot, config }) {
  if (!snapshot || !config) return null;

  const entryCheck = snapshot.entry_check;
  if (!entryCheck) return null;
  const qualifies = !entryCheck.reason;
  const checks = [
    { label: `Score ${snapshot.score} ≥ ${entryCheck.min_score} (bot-managed)`, pass: snapshot.score >= entryCheck.min_score },
    { label: 'Daily target is a progress goal, not an entry gate', pass: true },
    { label: entryCheck.reason || `Managed ${entryCheck.desk} entry checks passed`, pass: qualifies },
  ];

  return (
    <div className="surface p-4">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Would your bot take this?</p>
      <ul className="mt-2.5 space-y-1.5">
        {checks.map((check) => (
          <li key={check.label} className="flex items-center gap-2 text-xs">
            {check.pass ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
            ) : (
              <MinusCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={check.pass ? 'text-foreground/90' : 'text-muted-foreground'}>{check.label}</span>
          </li>
        ))}
      </ul>
      <p className={`mt-2.5 text-[11px] ${qualifies ? 'text-primary' : 'text-muted-foreground'}`}>
        {qualifies
          ? config.mode === 'auto'
            ? 'This setup clears entry checks — the bot can open it when funds, cooldown and a position slot allow.'
            : config.mode === 'approve'
              ? 'This setup clears your rules — it will come to you for approval.'
              : 'This setup clears your rules, but the bot is set to signals only.'
          : 'This one falls short of your rules, so the bot will pass on it.'}
      </p>
    </div>
  );
}