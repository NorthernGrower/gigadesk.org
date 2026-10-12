import React from 'react';
import { Loader2, SlidersHorizontal, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { MODE_HINT, MODE_LABEL } from '@/lib/market';
import { fmtUsd } from '@/lib/format';

const MODES = ['off', 'approve', 'auto'];

function Metric({ label, value, tone = 'neutral', hint }) {
  const tones = { up: 'text-primary', down: 'text-destructive', neutral: 'text-foreground', accent: 'text-accent' };
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/20 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={`num mt-1 text-base font-semibold ${tones[tone]}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default function BotControls({ config, stats, desk = 'live', onModeChange, onToggleAutoRun, onRunNow, running }) {
  const mode = config?.mode || 'approve';
  const cap = Number(stats?.cap) || 0;
  const exposure = Number(stats?.exposure) || 0;
  const deployPct = cap > 0 ? Math.max(0, Math.min(100, (exposure / cap) * 100)) : 0;
  const paper = desk === 'paper';

  return (
    <div className="surface space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-primary">{paper ? 'Paper trading bot' : 'Live trading bot'}</p>
          <p className="mt-1 font-heading text-lg font-semibold">{MODE_LABEL[mode]}</p>
          <p className="mt-0.5 max-w-md text-[11px] leading-relaxed text-muted-foreground">
            {paper
              ? 'Stats below are the paper desk\u2019s own — simulated balance, positions and booked results. Live stats are untouched on the Live Desk.'
              : 'Stats below are exchange-reported and the rules govern real orders only. The paper desk trades separately with its own rules.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1 rounded-xl border border-border/70 bg-secondary/40 p-0.5 sm:flex">
            {MODES.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => onModeChange(value)}
                className={`rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${
                  mode === value
                    ? value === 'off'
                      ? 'bg-secondary text-foreground ring-1 ring-border'
                      : value === 'approve'
                        ? 'bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/30'
                        : 'bg-primary/15 text-primary ring-1 ring-primary/30'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {MODE_LABEL[value]}
              </button>
            ))}
          </div>
          <Button onClick={onRunNow} disabled={running}>
            {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}
            Run a cycle
          </Button>
          <Button
            variant="outline"
            onClick={() => document.getElementById('risk-rules')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            title="Live bot rules"
          >
            <SlidersHorizontal className="mr-2 h-4 w-4" />
            Rules
          </Button>
        </div>
      </div>

      <div className="sm:hidden">
        <Select value={mode} onValueChange={onModeChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((value) => (
              <SelectItem key={value} value={value}>
                {MODE_LABEL[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {stats?.enabled === false ? (
        <p className="rounded-xl border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-300">
          Live trading is paused — no new real orders. Open real positions stay managed.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {paper ? (
          <>
            <Metric
              label="Paper balance"
              value={stats?.balance == null ? '—' : fmtUsd(stats.balance)}
              hint="Cash the paper bot can trade with"
            />
            <Metric
              label="Deployed (paper)"
              value={fmtUsd(exposure)}
              hint={`${stats?.openCount || 0} open paper positions`}
            />
            <Metric
              label="Unrealised (paper)"
              value={fmtUsd(stats?.unrealized || 0)}
              tone={(stats?.unrealized || 0) >= 0 ? 'up' : 'down'}
            />
            <Metric
              label="Today realised (paper)"
              value={fmtUsd(stats?.realizedToday || 0)}
              tone={(stats?.realizedToday || 0) >= 0 ? 'up' : 'down'}
              hint={stats?.dailyGoal != null ? `daily goal ${fmtUsd(stats.dailyGoal)}` : 'closed paper trades today'}
            />
          </>
        ) : (
          <>
            <Metric
              label="Exchange balance"
              value={stats?.balance == null ? '—' : fmtUsd(stats.balance)}
              hint={stats?.balanceStale ? stats?.balanceError || 'Unavailable — verify the connection' : 'Live funds on the exchange'}
            />
            <Metric
              label="Budget left"
              value={cap > 0 ? fmtUsd(stats?.budget ?? 0) : 'No cap'}
              hint={`${fmtUsd(exposure)} deployed${cap > 0 ? ` of ${fmtUsd(cap)} cap` : ''}`}
            />
            <Metric
              label="Unrealised (live)"
              value={fmtUsd(stats?.unrealized || 0)}
              tone={(stats?.unrealized || 0) >= 0 ? 'up' : 'down'}
            />
            <Metric
              label="Today realised (live)"
              value={fmtUsd(stats?.realizedToday || 0)}
              tone={(stats?.realizedToday || 0) >= 0 ? 'up' : 'down'}
              hint="closed real trades today"
            />
          </>
        )}
      </div>

      {!paper && cap > 0 ? (
        <div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Live budget deployed</span>
            <span className="num">{deployPct.toFixed(0)}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border/60">
            <div
              className={`h-full rounded-full ${deployPct >= 100 ? 'bg-destructive' : 'bg-accent'}`}
              style={{ width: `${deployPct}%` }}
            />
          </div>
        </div>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        {stats?.openCount || 0} {paper ? 'paper' : 'live'} positions open · {stats?.scanned || 0} coins scanned on the last cycle
      </p>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-secondary/20 px-3 py-2.5">
        <div>
          <p className="text-xs font-medium">Run automatically while the app is open</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Background cycles every couple of minutes, plus a full market scan every five.
          </p>
        </div>
        <Switch checked={config?.auto_run !== false} onCheckedChange={onToggleAutoRun} />
      </div>
    </div>
  );
}