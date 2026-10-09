import React, { useEffect, useState } from 'react';
import { Bell, BellRing, CheckCheck, Target, TrendingDown, TrendingUp, Zap } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
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

export default function AlertsFeed({ limit = 12, className = '' }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const rows = pageItems(
      await base44.entities.Alert.filter({}, { sort: '-created_date', limit }),
    );
    setAlerts(rows);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const unsubscribe = base44.entities.Alert.subscribe(() => load());
    const onTick = () => load();
    window.addEventListener('bot:tick', onTick);
    return () => {
      unsubscribe();
      window.removeEventListener('bot:tick', onTick);
    };
  }, [limit]);

  const markAllRead = async () => {
    const unread = alerts.filter((a) => !a.read);
    if (!unread.length) return;
    await Promise.all(unread.map((a) => base44.entities.Alert.update(a.id, { read: true })));
    setAlerts((prev) => prev.map((a) => ({ ...a, read: true })));
  };

  const unreadCount = alerts.filter((a) => !a.read).length;

  return (
    <div className={`surface p-4 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {unreadCount ? <BellRing className="h-4 w-4 text-primary" /> : <Bell className="h-4 w-4 text-muted-foreground" />}
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Alerts</p>
          {unreadCount ? (
            <span className="num rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{unreadCount}</span>
          ) : null}
        </div>
        {unreadCount ? (
          <Button size="sm" variant="ghost" className="h-7 text-[11px] text-muted-foreground" onClick={markAllRead}>
            Mark all read
          </Button>
        ) : null}
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading alerts…</p>
      ) : alerts.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No alerts yet. Setups that clear your score and target bars land here the moment a scan finds them.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
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
                    <p className="text-xs font-medium leading-snug">{alert.title}</p>
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
  );
}