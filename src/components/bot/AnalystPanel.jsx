import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { deskAnalyst } from '@/lib/market';

const STANCE = {
  stand_aside: { label: 'Stand aside', tone: 'bg-muted text-muted-foreground' },
  selective: { label: 'Selective', tone: 'bg-primary/10 text-primary' },
  normal: { label: 'Normal', tone: 'bg-primary/10 text-primary' },
  caution: { label: 'Caution', tone: 'bg-destructive/10 text-destructive' },
};

const VERDICT = {
  in_line: { label: 'in line with its backtest', tone: 'text-primary' },
  below_backtest: { label: 'below half its backtest', tone: 'text-amber-400' },
  losing: { label: 'losing on average', tone: 'text-destructive' },
  too_few: { label: 'too few trades to judge', tone: 'text-muted-foreground' },
  unmeasured: { label: 'no measured expectation', tone: 'text-muted-foreground' },
};

const SOURCE_LABEL = { v3: 'V3 entries', gated: 'Gated entries', top_pick: 'Top picks' };

// The desk analyst's own panel. It is commentary and nothing else: it reads a
// note the deskAnalyst function produced and renders it. No control here
// reaches the bot — the switch lives with the other engine toggles in the
// desk's rules, and with it off this panel makes no server call at all.
export default function AnalystPanel({ desk = 'paper', config }) {
  const on = desk === 'live' ? config?.live_rules?.analyst_on === true : config?.analyst_on === true;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    if (!on) {
      setLoading(false);
      return () => {
        alive = false;
      };
    }
    setLoading(true);
    deskAnalyst(desk)
      .then((res) => {
        if (alive) setData(res);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [desk, on]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await deskAnalyst(desk, true));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const note = data?.note || null;
  const stance = STANCE[note?.stance] || STANCE.normal;
  const closes = Array.isArray(note?.closes) ? note.closes : [];
  const watch = Array.isArray(note?.watch) ? note.watch : [];
  const groups = (data?.decay?.groups || []).filter((g) => g.trades > 0 || g.expectation);
  const counts = data?.digest?.counts || null;

  return (
    <div className="surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <p className="font-heading text-sm font-medium">Desk analyst</p>
        </div>
        {on ? (
          <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        ) : null}
      </div>

      {!on ? (
        <p className="mt-3 text-sm text-muted-foreground">
          The analyst is off for the {desk} desk. Turn it on in the desk&apos;s rules, next to the V3 algorithm under
          Scan &amp; engines — it adds a daily read of this desk and nothing else.
        </p>
      ) : loading && !data ? (
        <p className="mt-3 text-sm text-muted-foreground">Reading the desk…</p>
      ) : error ? (
        <p className="mt-3 text-sm text-destructive">{error}</p>
      ) : !data?.enabled ? (
        <p className="mt-3 text-sm text-muted-foreground">{data?.reason || 'Nothing to read yet.'}</p>
      ) : (
        <>
          {note?.headline ? (
            <div className="mt-3 flex items-start justify-between gap-3">
              <p className="text-sm font-medium leading-snug">{note.headline}</p>
              <span className={`num shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold ${stance.tone}`}>
                {stance.label}
              </span>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              The desk&apos;s numbers are below. The written read is unavailable
              {note?.model_error ? ` (${note.model_error})` : ''} — the numbers stand on their own.
            </p>
          )}

          {note?.summary ? (
            <p className="mt-2 text-[13px] leading-snug text-muted-foreground">{note.summary}</p>
          ) : null}

          {counts ? (
            <p className="num mt-2 text-[11px] text-muted-foreground">
              {counts.closed_180d} closed in 180 days · {counts.open} open · booked{' '}
              {data.digest.booked.usd_180d >= 0 ? '+' : ''}
              {data.digest.booked.usd_180d} USD
            </p>
          ) : null}

          {closes.length ? (
            <div className="mt-3 space-y-2">
              <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Last closes</p>
              {closes.map((row) => (
                <div key={`${row.symbol}-${row.note.slice(0, 12)}`} className="rounded-lg border border-border/60 px-3 py-2">
                  <p className="text-xs font-medium">{row.symbol}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{row.note}</p>
                </div>
              ))}
            </div>
          ) : null}

          {groups.length ? (
            <div className="mt-3 space-y-1.5">
              <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Against the backtest</p>
              {groups.map((g) => {
                const verdict = VERDICT[g.verdict] || VERDICT.unmeasured;
                return (
                  <div key={g.source} className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-muted-foreground">
                      {SOURCE_LABEL[g.source] || g.source} · {g.trades} closed · {g.mean_pct > 0 ? '+' : ''}
                      {g.mean_pct}% avg · {g.win_rate}% wins
                    </span>
                    <span className={`num shrink-0 font-semibold ${verdict.tone}`}>{verdict.label}</span>
                  </div>
                );
              })}
              {data.decay?.state === 'too_few' || data.decay?.state === 'unmeasured' ? (
                <p className="text-[11px] leading-snug text-muted-foreground">
                  A verdict needs {data.decay.min_trades} closed trades on one entry source. Until then this is a
                  direction, not a result.
                </p>
              ) : null}
            </div>
          ) : null}

          {watch.length ? (
            <div className="mt-3">
              <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Watching</p>
              <ul className="mt-1 space-y-1">
                {watch.map((line) => (
                  <li key={line} className="text-[11px] leading-snug text-muted-foreground">
                    · {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {note?.risks ? (
            <p className="mt-3 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
              {note.risks}
            </p>
          ) : null}

          <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
            Read-only. The analyst cannot open, close, size or approve a trade, and every number above comes from the
            desk&apos;s own records — one note per day, refreshed when you ask.
          </p>
        </>
      )}
    </div>
  );
}
