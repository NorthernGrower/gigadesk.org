import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  BookOpen,
  Bot as BotIcon,
  LayoutDashboard,
  Radar,
  Settings as SettingsIcon,
  Star,
  TrendingUp,
} from 'lucide-react';

const NAV = [
  { to: '/dashboard', label: 'Desk', icon: LayoutDashboard },
  { to: '/screener', label: 'Scanner', icon: Radar },
  { to: '/bot', label: 'Bot', icon: BotIcon },
  { to: '/journal', label: 'Journal', icon: BookOpen },
  { to: '/watchlist', label: 'Watchlist', icon: Star },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/30">
        <TrendingUp className="h-4 w-4 text-primary" />
      </span>
      <span className="leading-tight">
        <span className="block font-heading text-sm font-semibold tracking-tight">
          Giga<span className="text-primary">Desk</span>
        </span>
        <span className="block text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          market desk
        </span>
      </span>
    </div>
  );
}

export default function Sidebar() {
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-sidebar-border bg-sidebar-background/80 px-3 py-5 backdrop-blur md:flex">
        <Brand />
        <nav className="mt-8 flex flex-1 flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${
                  isActive
                    ? 'bg-sidebar-accent text-foreground ring-1 ring-primary/20'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="px-2 text-[10px] leading-relaxed text-muted-foreground">
          Paper trading on live prices. Analysis, not financial advice.
        </p>
      </aside>

      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-border bg-background/95 px-2 py-1.5 backdrop-blur md:hidden">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-1 rounded-lg py-1.5 text-[10px] ${
                isActive ? 'text-primary' : 'text-muted-foreground'
              }`
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}