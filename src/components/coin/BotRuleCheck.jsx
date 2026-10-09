import React from 'react';
import { CheckCircle2, MinusCircle } from 'lucide-react';
import { fmtPct } from '@/lib/format';

export default function BotRuleCheck({ snapshot, config }) {
  if (!snapshot || !config) return null;

  const minScore = Number(config.min_score) || 62;
  const target = Number(config.daily_target_pct) || 2;
  const sideBlocked = snapshot.side === 'short' && config.allow_shorts === false;
  const checks = [
    { label: `Score ${snapshot.score} ≥ ${minScore}`, pass: snapshot.score >= minScore },
    { label: `Moves ${fmtPct(snapshot.required_move_pct, 1)} to target vs your ${target}% bar`, pass: !config.require_daily_target || snapshot.required_move_pct >= target },
    { label: snapshot.side === 'short' ? 'Shorts allowed' : 'Long side', pass: !sideBlocked },
  ];
  const qualifies = checks.every((c) => c.pass);

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
            ? 'This setup clears your rules — the bot can open it on its next cycle.'
            : config.mode === 'approve'
              ? 'This setup clears your rules — it will come to you for approval.'
              : 'This setup clears your rules, but the bot is set to signals only.'
          : 'This one falls short of your rules, so the bot will pass on it.'}
      </p>
    </div>
  );
}