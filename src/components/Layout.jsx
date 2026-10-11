import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Activity } from 'lucide-react';
import BotRunner from '@/components/BotRunner';
import Sidebar from '@/components/layout/Sidebar';
import BotStatusPill from '@/components/layout/BotStatusPill';
import { ensureBotConfig } from '@/lib/market';

export default function Layout() {
  const [config, setConfig] = useState(null);
  const [running, setRunning] = useState(false);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    ensureBotConfig()
      .then((cfg) => {
        if (alive) setConfig(cfg);
      })
      .catch(() => {});
    const onTick = (event) => {
      setRunning(false);
      if (event.detail?.config) setConfig(event.detail.config);
    };
    const onManual = () => setRunning(true);
    window.addEventListener('bot:tick', onTick);
    window.addEventListener('bot:run', onManual);
    const timer = setInterval(() => setClock(new Date()), 30000);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('bot:tick', onTick);
      window.removeEventListener('bot:run', onManual);
    };
  }, []);

  return (
    <div className="min-h-screen">
      <BotRunner />
      <Sidebar />

      <div className="md:pl-60">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border/70 bg-background/85 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex items-center gap-2 md:hidden">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
              <Activity className="h-3.5 w-3.5 text-primary" />
            </span>
            <span className="font-heading text-sm font-semibold">
              Giga<span className="text-primary">Desk</span>
            </span>
          </div>
          <p className="hidden text-[11px] uppercase tracking-[0.16em] text-muted-foreground md:block">
            Live market desk · {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} UTC
          </p>
          <BotStatusPill config={config} running={running} />
        </header>

        <main className="mx-auto max-w-[1500px] space-y-4 px-4 pb-24 pt-4 md:px-6 md:pb-10">
          <Outlet />
        </main>

        <footer className="mx-auto max-w-[1500px] px-4 pb-24 text-[11px] leading-relaxed text-muted-foreground md:px-6 md:pb-8">
          GigaDesk analyses live prices and trades your strategies on paper. Nothing here is financial advice, and no
          performance is guaranteed — markets can lose money as easily as they make it.
        </footer>
      </div>
    </div>
  );
}