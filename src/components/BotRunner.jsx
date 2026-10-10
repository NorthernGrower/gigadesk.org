import { useEffect, useRef } from 'react';
import { ensureBotConfig, emitBotTick, runBot } from '@/lib/market';

const LIGHT_INTERVAL = 90000;
const FULL_INTERVAL = 300000;

/** Keeps the bot ticking while the app is open, in one place, for every page. */
export default function BotRunner() {
  const configRef = useRef(null);

  useEffect(() => {
    let alive = true;
    let lightTimer = null;
    let fullTimer = null;

    const cycle = async (light) => {
      try {
        // re-read the rules each cycle so header toggles (auto, live) apply right away
        const config = await ensureBotConfig();
        configRef.current = config;
        if (!alive) return;
        if (!light && (!config.auto_run || config.mode === 'off')) return;
        const data = await runBot(light);
        if (alive) emitBotTick(data);
      } catch {
        // a quiet failure here just means the next cycle tries again
      }
    };

    const boot = async () => {
      try {
        configRef.current = await ensureBotConfig();
      } catch {
        configRef.current = null;
      }
      if (!alive) return;
      cycle(true);
      lightTimer = setInterval(() => cycle(true), LIGHT_INTERVAL);
      fullTimer = setInterval(() => cycle(false), FULL_INTERVAL);
    };

    boot();
    const onManual = () => cycle(false);
    window.addEventListener('bot:run', onManual);
    return () => {
      alive = false;
      if (lightTimer) clearInterval(lightTimer);
      if (fullTimer) clearInterval(fullTimer);
      window.removeEventListener('bot:run', onManual);
    };
  }, []);

  return null;
}