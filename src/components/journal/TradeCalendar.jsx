import React, { useMemo, useState } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import TradeTable from '@/components/journal/TradeTable';
import { fmtUsd } from '@/lib/format';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// the day a trade belongs to: the day it opened, else the day it was written
function dayOf(trade) {
  const iso = (trade && (trade.opened_at || trade.created_date)) || '';
  if (!iso) return '';
  try {
    const date = parseISO(String(iso));
    return Number.isNaN(date.getTime()) ? '' : format(date, 'yyyy-MM-dd');
  } catch {
    return '';
  }
}

function atOf(trade) {
  const ms = Date.parse(String((trade && (trade.opened_at || trade.created_date)) || ''));
  return Number.isNaN(ms) ? 0 : ms;
}

// what a set of trades booked: only a closed trade has a result
function booked(trades) {
  return trades.reduce((sum, trade) => sum + (trade.status === 'closed' ? Number(trade.pnl_usd) || 0 : 0), 0);
}

// The journal as a calendar: a month grid with a marker on every day that traded,
// and a day's own trades behind a tap. The month is the unit, so the page never
// grows into a long list of everything the bot ever opened.
export default function TradeCalendar({ trades = [], month, onMonthChange, loading = false, onChanged }) {
  const [selected, setSelected] = useState(null);

  const byDay = useMemo(() => {
    const map = new Map();
    for (const trade of trades) {
      const key = dayOf(trade);
      if (!key) continue;
      const list = map.get(key) || [];
      list.push(trade);
      map.set(key, list);
    }
    // a day reads in the order it happened, not newest first
    for (const list of map.values()) list.sort((a, b) => atOf(a) - atOf(b));
    return map;
  }, [trades]);

  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
        end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }),
      }),
    [month],
  );

  const monthKey = format(month, 'yyyy-MM');
  const monthTrades = trades.filter((trade) => dayOf(trade).startsWith(monthKey));
  const monthClosed = monthTrades.filter((trade) => trade.status === 'closed');
  const monthNet = booked(monthTrades);
  const thisMonth = isSameMonth(month, new Date());

  const selectedKey = selected ? format(selected, 'yyyy-MM-dd') : '';
  const selectedTrades = selectedKey ? byDay.get(selectedKey) || [] : [];
  const selectedNet = booked(selectedTrades);

  const summary = loading
    ? 'Reading this month…'
    : monthTrades.length
      ? `${monthTrades.length} trade${monthTrades.length === 1 ? '' : 's'}${
          monthClosed.length ? ` · ${fmtUsd(monthNet)} booked` : ''
        }`
      : 'No trades this month';

  return (
    <div className="surface space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {thisMonth ? 'This month' : 'Month'}
          </p>
          <p className="font-display text-base font-semibold">{format(month, 'MMMM yyyy')}</p>
          <p className="num mt-0.5 text-[11px] text-muted-foreground">{summary}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => onMonthChange(addMonths(startOfMonth(month), -1))}
            title="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-[11px]"
            onClick={() => onMonthChange(startOfMonth(new Date()))}
            disabled={thisMonth}
          >
            Today
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => onMonthChange(addMonths(startOfMonth(month), 1))}
            title="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className={`space-y-1 ${loading ? 'opacity-60' : ''}`}>
        <div className="grid grid-cols-7 gap-1">
          {WEEKDAYS.map((label) => (
            <span
              key={label}
              className="text-center text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
            >
              {label}
            </span>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {days.map((day) => {
            const key = format(day, 'yyyy-MM-dd');
            const list = byDay.get(key) || [];
            const inMonth = isSameMonth(day, month);
            const net = booked(list);
            const closed = list.some((trade) => trade.status === 'closed');
            const classes = [
              'flex min-h-[52px] flex-col justify-between rounded-lg border p-1.5 text-left transition-colors sm:min-h-[64px]',
              inMonth ? '' : 'opacity-35',
              list.length ? 'border-border/70 bg-secondary/30 hover:border-primary/50' : 'border-transparent',
              isToday(day) ? 'ring-1 ring-primary/40' : '',
            ]
              .filter(Boolean)
              .join(' ');
            const content = (
              <>
                <span className={`num text-[11px] ${list.length ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {format(day, 'd')}
                </span>
                {list.length ? (
                  <span className="mt-1 flex w-full items-center gap-1">
                    <span className={`h-1.5 w-1.5 rounded-full ${closed && net < 0 ? 'bg-destructive' : 'bg-primary'}`} />
                    <span className="num text-[10px] text-muted-foreground">{list.length}</span>
                    {closed ? (
                      <span
                        className={`num ml-auto hidden text-[10px] sm:inline ${
                          net < 0 ? 'text-destructive' : 'text-primary'
                        }`}
                      >
                        {fmtUsd(net, 0)}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </>
            );

            if (!list.length) {
              return (
                <div key={key} className={classes} aria-hidden="true">
                  {content}
                </div>
              );
            }
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelected(day)}
                className={classes}
                title={`${list.length} trade${list.length === 1 ? '' : 's'} on ${format(day, 'MMM d')}`}
              >
                {content}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {monthTrades.length
          ? 'Tap a marked day to open that day’s trades.'
          : 'Days with trades carry a marker, with their count and what they booked.'}
      </p>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{selected ? format(selected, 'EEEE, MMM d') : ''}</DialogTitle>
            <DialogDescription className="num">
              {selectedTrades.length
                ? `${selectedTrades.length} trade${selectedTrades.length === 1 ? '' : 's'}${
                    selectedTrades.some((trade) => trade.status === 'closed') ? ` · ${fmtUsd(selectedNet)} booked` : ''
                  }`
                : 'No trades left on this day'}
            </DialogDescription>
          </DialogHeader>
          <div className="-mr-1 max-h-[65vh] overflow-y-auto pr-1">
            {selectedTrades.length ? (
              <TradeTable trades={selectedTrades} onChanged={onChanged} />
            ) : (
              <p className="text-[11px] text-muted-foreground">
                This day’s trades were removed from the journal.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
