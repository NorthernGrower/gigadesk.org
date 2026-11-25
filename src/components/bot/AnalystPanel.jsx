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

// only a measured source gets a verdict. Top picks and gated entries show their
// numbers and no judgement, so they have no entry here
const VERDICT = {
  in_line: { label: 'in line with its backtest', tone: 'text-primary' },
  below_backtest: { label: 'below half its backtest', tone: 'text-amber-400' },
  losing: { label: 'losing on average', tone: 'text-destructive' },
  too_few: { label: 'too few trades to judge', tone: 'text-muted-foreground' },
};

const SOURCE_LABEL = { v3: 'V3', gated: 'Gated', top_pick: 'Top picks' };

const Label = ({ children }) => (
  <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{children}</p>
);

const Chip = ({ tone, children }) => (
  <span className={`rounded border border-border/60 px-1 py-px text-[9px] ${tone}`}>{children}</span>
);

// The desk analyst's panel. It is commentary and nothing else: it shows what the
// analyst function returned. No control here reaches the bot. The switch lives
// with the desk's engine toggles, and with it off this panel makes no server
// call at all.
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
  const context = data?.context || null;
  const setups = Array.isArray(context?.setups) ? context.setups : [];
  const alerts = Array.isArray(context?.alerts) ? context.alerts : [];
  const watchlist = Array.isArray(context?.watchlist) ? context.watchlist : [];
  const btc = context?.btc || null;
  const closes = Array.isArray(note?.closes) ? note.closes : [];
  const watch = Array.isArray(note?.watch) ? note.watch : [];
  // only sources that actually traded are listed
  const groups = (data?.decay?.groups || []).filter((g) => g.trades > 0);
  const counts = data?.digest?.counts || null;
  const booked = data?.digest?.booked?.usd_180d;

  return (
    <div className="surface space-y-2.5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <p className="font-heading text-xs font-medium">Desk analyst</p>
        </div>
        {on ? (
          <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={refresh} disabled={loading} aria-label="Refresh the analyst">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        ) : null}
      </div>

      {!on ? (
        <p className="text-[11px] text-muted-foreground">
          Off for the {desk} desk. Switch it on under Scan &amp; engines in the desk rules.
        </p>
      ) : loading && !data ? (
        <p className="text-[11px] text-muted-foreground">Reading the desk…</p>
      ) : error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : !data?.enabled ? (
        <p className="text-[11px] text-muted-foreground">{data?.reason || 'Nothing to read yet.'}</p>
      ) : (
        <>
          {note?.headline ? (
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] font-medium leading-snug">{note.headline}</p>
              <span className={`num shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${stance.tone}`}>
                {stance.label}
              </span>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              The written read is unavailable{note?.model_error ? ` (${note.model_error})` : ''}. The numbers stand on their own.
            </p>
          )}

          {note?.summary ? <p className="text-[11px] leading-snug text-muted-foreground">{note.summary}</p> : null}

          {counts ? (
            <p className="num text-[10px] text-muted-foreground">
              {counts.closed_180d} closed in 180 days · {counts.open} open · booked {booked >= 0 ? '+' : ''}
              {booked} USD
            </p>
          ) : null}

          {btc ? (
            <p className="text-[10px] text-muted-foreground">
              BTC{btc.above_200d == null ? '' : btc.above_200d ? ' above' : ' below'}
              {btc.above_200d == null ? '' : ' its 200-day average'}
              {btc.change_24h_pct != null ? ` · ${btc.change_24h_pct > 0 ? '+' : ''}${btc.change_24h_pct}% on the day` : ''}
            </p>
          ) : null}

          {setups.length ? (
            <div className="space-y-1">
              <Label>
                Scanner setups{context?.setups_total > setups.length ? ` · top ${setups.length} of ${context.setups_total}` : ''}
              </Label>
              {setups.map((s) => (
                <div key={s.symbol} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-medium">
                    {s.symbol} <span className="font-normal text-muted-foreground">{s.side} · {s.score}</span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Chip tone={s.entry_ready ? 'text-primary' : 'text-muted-foreground'}>
                      {s.entry_ready ? 'entry ready' : 'extended'}
                    </Chip>
                    {context?.scored === false ? null : (
                      <Chip tone={s.clears_bar ? 'text-primary' : 'text-muted-foreground'}>
                        {s.clears_bar ? 'clears bar' : 'under bar'}
                      </Chip>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {alerts.length ? (
            <div className="space-y-1">
              <Label>Alerts, last 24h</Label>
              {alerts.map((a, i) => (
                <p key={`${a.kind}-${i}`} className="text-[11px] leading-snug text-muted-foreground">
                  {a.title}
                </p>
              ))}
            </div>
          ) : null}

          {watchlist.length ? (
            <p className="text-[10px] leading-snug text-muted-foreground">
              <span className="uppercase tracking-[0.14em]">Watchlist </span>
              {watchlist.map((w) => `${w.symbol}${w.score_now != null ? ` ${w.score_now}` : ''}`).join(' · ')}
            </p>
          ) : null}

          {closes.length ? (
            <div className="space-y-1">
              <Label>Last closes</Label>
              {closes.map((row) => (
                <p key={`${row.symbol}-${row.note.slice(0, 12)}`} className="text-[11px] leading-snug text-muted-foreground">
                  <span className="font-medium text-foreground">{row.symbol}</span> {row.note}
                </p>
              ))}
            </div>
          ) : null}

          {groups.length ? (
            <div className="space-y-1">
              <Label>Entry sources</Label>
              {groups.map((g) => {
                const verdict = VERDICT[g.verdict];
                return (
                  <div key={g.source} className="flex items-center justify-between gap-2 text-[10px]">
                    <span className="text-muted-foreground">
                      {SOURCE_LABEL[g.source] || g.source} · {g.trades} · {g.mean_pct > 0 ? '+' : ''}
                      {g.mean_pct}% avg · {g.win_rate}% wins
                    </span>
                    {verdict ? <span className={`num shrink-0 font-semibold ${verdict.tone}`}>{verdict.label}</span> : null}
                  </div>
                );
              })}
              {data.decay?.state === 'too_few' ? (
                <p className="text-[10px] leading-snug text-muted-foreground">
                  A verdict needs {data.decay.min_trades} closed trades on one source.
                </p>
              ) : null}
            </div>
          ) : null}

          {watch.length ? (
            <ul className="space-y-0.5">
              {watch.map((line) => (
                <li key={line} className="text-[11px] leading-snug text-muted-foreground">
                  · {line}
                </li>
              ))}
            </ul>
          ) : null}

          {note?.risks ? <p className="text-[11px] leading-snug text-muted-foreground">Risk: {note.risks}</p> : null}

          <p className="text-[10px] leading-snug text-muted-foreground">
            Read-only: it never places, sizes or skips a trade. Written once a day, or when you refresh.
          </p>
        </>
      )}
    </div>
  );
}
