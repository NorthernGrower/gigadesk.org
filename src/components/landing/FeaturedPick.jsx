import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Clock3, Sparkles } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import CoinAvatar from '@/components/common/CoinAvatar';
import { fmtPct, fmtPrice } from '@/lib/format';

/**
 * The homepage ad: one setup from the desk's top 10 of the day, with its AI
 * analysis, rotated every 24 hours.
 */
export default function FeaturedPick() {
  const [pick, setPick] = useState(null);

  useEffect(() => {
    let alive = true;
    base44.functions
      .invoke('pickOfTheDay', {})
      .then((res) => {
        if (alive) setPick(res.data?.pick || null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!pick) return null;
  const isShort = pick.side === 'short';

  return (
    <section className="mb-14">
      <div className="surface relative overflow-hidden p-6 md:p-8">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <span className="rounded-md bg-primary/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-primary ring-1 ring-primary/30">
            Featured call of the day
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock3 className="h-3.5 w-3.5" /> One of today's top 10 desk picks — rotated every 24 hours
          </span>
        </div>

        <div className="relative mt-6 grid gap-8 md:grid-cols-2">
          <div>
            <div className="flex items-center gap-3">
              <CoinAvatar symbol={pick.symbol} size="lg" />
              <div className="min-w-0">
                <p className="font-heading text-xl font-semibold leading-tight">{pick.symbol}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
                      isShort ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
                    }`}
                  >
                    {pick.side}
                  </span>
                  <span className="num text-sm text-muted-foreground">{fmtPrice(pick.price)}</span>
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-primary">
                    Score {Math.round(pick.score)}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Entry</p>
                <p className="num mt-0.5 text-sm">{fmtPrice(pick.entry)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Target</p>
                <p className="num mt-0.5 text-sm text-primary">{fmtPrice(pick.target)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Stop</p>
                <p className="num mt-0.5 text-sm text-destructive">{fmtPrice(pick.stop)}</p>
              </div>
            </div>

            {pick.reasons?.length ? (
              <ul className="mt-4 space-y-1.5">
                {pick.reasons.slice(0, 2).map((reason) => (
                  <li key={reason} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                    {reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div>
            <div className="rounded-2xl border border-border/60 bg-secondary/25 p-4">
              <p className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5 text-primary" /> AI read on this call
              </p>
              {pick.ai ? (
                <>
                  <p className="mt-3 text-[13px] leading-relaxed">{pick.ai.thesis}</p>
                  {pick.ai.risks ? (
                    <p className="mt-3 border-t border-border/60 pt-3 text-[12px] leading-relaxed text-muted-foreground">
                      Risks: {pick.ai.risks}
                    </p>
                  ) : null}
                  <p className="num mt-3 text-[11px] text-muted-foreground">
                    Model confidence {pick.ai.confidence}% · needs {fmtPct(pick.required_move_pct, 1)} to target · {pick.risk_reward}:1
                  </p>
                </>
              ) : (
                <p className="mt-3 text-[13px] text-muted-foreground">The AI read is being written — check back in a moment.</p>
              )}
            </div>
            <Link
              to="/register"
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Trade this on your desk <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}