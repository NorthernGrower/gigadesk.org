import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Bot, Radar, TrendingUp, Users } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import Image from '@/components/ui/image';
import TickerBox from '@/components/landing/TickerBox';

const MASCOT =
  'https://media.base44.com/images/public/6ac856fac6ab24fc6a13a00c/6a9a43276_generated_image.png';

const EMPTY = {
  equity: 1000000,
  growth_pct: 0,
  today_pnl: 0,
  today_pct: 0,
  win_rate: 0,
  closed_count: 0,
  open_count: 0,
  best_trade: 0,
};

const FEATURES = [
  {
    icon: Bot,
    title: 'A bot with three gears',
    text: 'Off for signals only, Approve when you want the final say, Auto when you are ready to let the desk trade itself.',
  },
  {
    icon: Radar,
    title: 'Whole-market scan',
    text: 'Every tradable coin on the exchange, ranked by real momentum, volume flow and risk-reward — not just the top ten.',
  },
  {
    icon: Users,
    title: 'Smart money tracking',
    text: "See where the top-performing on-chain traders are positioned and let their flow nudge the bot's picks.",
  },
];

export default function Landing() {
  const [stats, setStats] = useState(EMPTY);

  useEffect(() => {
    let alive = true;
    const load = () =>
      base44.functions
        .invoke('gigaTicker', {})
        .then((res) => {
          if (alive && res?.data && !res.data.error) setStats(res.data);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="min-h-screen">
      {/* top bar */}
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/30">
              <TrendingUp className="h-4 w-4 text-primary" />
            </span>
            <span className="font-heading text-lg font-bold tracking-tight">
              Giga<span className="text-primary">Desk</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/login"
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Sign in
            </Link>
            <Link
              to="/register"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 md:px-6">
        {/* the ticker box */}
        <section className="pt-6">
          <TickerBox stats={stats} />
        </section>

        {/* hero */}
        <section className="grid items-center gap-8 py-14 md:grid-cols-2 md:py-20">
          <div>
            <p className="font-display text-[11px] uppercase tracking-[0.2em] text-primary">
              the desk that never sleeps
            </p>
            <h1 className="mt-3 font-heading text-4xl font-bold leading-tight tracking-tight md:text-5xl">
              Your million-dollar desk, running itself.
            </h1>
            <p className="mt-4 max-w-lg text-base leading-relaxed text-muted-foreground md:text-lg">
              GigaDesk scans the entire market, reads the smart money, and works its
              $1,000,000 desk around the clock — with real stop-loss discipline and a
              daily profit target. You keep the final word.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link
                to="/register"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              >
                Open your desk <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/login"
                className="inline-flex items-center gap-2 rounded-lg border border-border px-6 py-3 text-sm font-semibold transition-colors hover:bg-secondary"
              >
                Sign in
              </Link>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              The ticker above shows the live bot's results scaled to a $1,000,000 desk.
            </p>
          </div>
          <div className="relative mx-auto w-full max-w-md">
            <div className="absolute inset-0 rounded-3xl bg-primary/10 blur-3xl" />
            <Image
              src={MASCOT}
              alt="GigaDesk mascot at his trading desk"
              className="relative w-full rounded-3xl border border-border/70"
              fittingType="fit"
            />
          </div>
        </section>

        {/* features */}
        <section className="grid gap-4 pb-14 md:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="surface p-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/30">
                <Icon className="h-5 w-5 text-primary" />
              </span>
              <h3 className="mt-4 font-heading text-base font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
            </div>
          ))}
        </section>

        {/* closing CTA */}
        <section className="surface mb-14 p-8 text-center md:p-12">
          <h2 className="font-heading text-2xl font-bold md:text-3xl">
            Giga does not stop. Neither does the desk.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground md:text-base">
            Set your risk, pick your style, and watch the bot work — paper first, real
            orders only when you say so.
          </p>
          <Link
            to="/register"
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Start free <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </main>

      <footer className="border-t border-border/70 py-8">
        <p className="mx-auto max-w-6xl px-4 text-xs leading-relaxed text-muted-foreground md:px-6">
          GigaDesk trades paper on live prices and only sends real orders when you
          explicitly allow it. Nothing here is financial advice and no performance is
          guaranteed — markets can lose money as easily as they make it.
        </p>
      </footer>
    </div>
  );
}