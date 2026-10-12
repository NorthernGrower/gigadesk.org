import React, { useEffect, useState } from 'react';
import { Bell, BellRing, CheckCheck, Target, Trash2, TrendingDown, TrendingUp, X, Zap } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { pageItems } from '@/lib/market';
import { timeAgo } from '@/lib/format';

const ICONS = {
  new_setup: Zap,
  target_hit: Target,
  stop_hit: TrendingDown,
  bot_open: TrendingUp,
  bot_close: CheckCheck,
  daily_goal: Target,
};

const TONES = {
  success: 'text-primary',
  danger: 'text-destructive',
  warning: 'text-amber-300',
  info: 'text-accent',
};

/** Paper / live tag for one alert: live trading comes from the exchange, everything else is the paper desk. */
function DeskBadge({ mode }) {
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
        mode === 'live'
          ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/30'
          : 'bg-secondary text-muted-foreground ring-1 ring-border'
      }`}
    >
      {mode === 'live' ? 'Live' : 'Paper'}
    </span>
  );
}

/** The header's alert bell: unread count on the icon, the latest alerts in a dropdown. */
export default function AlertsBell() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = async () => {
    const rows = pageItems(await base44.entities.Alert.filter({}, { sort: '-created_date', limit: 15 }));
    // alerts written before desk labels existed: their trade tells the desk —
    // a real-money trade is live, anything else belongs to the paper desk
    const missing = rows.filter((a) => !a.mode && a.trade_id);
    if (missing.length) {
      try {
        const trades = pageItems(
          await base44.entities.Trade.filter({ id: { $in: missing.map((a) => a.trade_id) } }, { limit: 50, fields: ['id', 'mode'] }),
        );
        const byId = new Map(trades.map((t) => [t.id, t.mode]));
        rows.forEach((a) => {
          if (!a.mode) a.mode = byId.get(a.trade_id) === 'real' ? 'live' : 'paper';
        });
      } catch {
        // a failed lookup just leaves the desk badge off
      }
    }
    rows.forEach((a) => {
      if (!a.mode) a.mode = a.kind === 'order_failed' ? 'live' : 'paper';
    });
    setAlerts(rows);
    setLoading(false);
  };

  useEffect(() => {
    let alive = true;
    const safeLoad = () => {
      load().catch(() => {
        if (alive) setLoading(false);
      });
    };
    safeLoad();
    if (open) safeLoad();
    // live changes refresh here, but bursts (one cycle writes many alerts at
    // once) are coalesced into a single query — reloading on every event and
    // every market tick tripped the entity rate limit
    let timer = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        safeLoad();
      }, 2000);
    };
    const unsubscribe = base44.entities.Alert.subscribe(schedule);
    return () => {
      alive = false;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [open]);

  const markAllRead = async () => {
    const unread = alerts.filter((a) => !a.read);
    if (!unread.length) return;
    await Promise.all(unread.map((a) => base44.entities.Alert.update(a.id, { read: true })));
    setAlerts((prev) => prev.map((a) => ({ ...a, read: true })));
  };

  const deleteAlert = async (id) => {
    await base44.entities.Alert.delete(id);
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  };

  const deleteAll = async () => {
    if (!alerts.length) return;
    await Promise.all(alerts.map((a) => base44.entities.Alert.delete(a.id)));
    setAlerts([]);
  };

  const unreadCount = alerts.filter((a) => !a.read).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Alerts"
          className="relative rounded-lg border border-border/70 bg-secondary/40 p-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          {unreadCount ? <BellRing className="h-4 w-4 text-primary" /> : <Bell className="h-4 w-4" />}
          {unreadCount ? (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
              {unreadCount}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Alerts</p>
          <div className="flex items-center gap-2">
            <span className="num text-[10px] text-muted-foreground">{unreadCount ? `${unreadCount} new` : ''}</span>
            {unreadCount ? (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-muted-foreground" onClick={markAllRead}>
                Mark all read
              </Button>
            ) : null}
            {alerts.length ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                onClick={deleteAll}
                title="Delete every alert"
              >
                <Trash2 className="h-3 w-3" />
                Clear
              </Button>
            ) : null}
          </div>
        </div>
        <div className="max-h-[400px] overflow-y-auto p-2">
          {loading ? (
            <p className="p-3 text-sm text-muted-foreground">Loading alerts…</p>
          ) : alerts.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              No alerts yet. Setups that clear your score and target bars land here the moment a scan finds them.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {alerts.map((alert) => {
                const Icon = ICONS[alert.kind] || Bell;
                return (
                  <li
                    key={alert.id}
                    className={`rounded-xl border px-3 py-2.5 ${
                      alert.read ? 'border-border/50 bg-secondary/15' : 'border-primary/25 bg-primary/5'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${TONES[alert.severity] || TONES.info}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-medium leading-snug">{alert.title}</p>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <DeskBadge mode={alert.mode} />
                            <button
                              type="button"
                              title="Delete this alert"
                              className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => deleteAlert(alert.id)}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                        {alert.message ? (
                          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{alert.message}</p>
                        ) : null}
                        <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                          {timeAgo(alert.created_date)}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}