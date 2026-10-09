import React from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { TIMEFRAMES, TIERS } from '@/lib/market';
import { fmtClock } from '@/lib/format';

export default function FiltersBar({
  timeframe,
  onTimeframe,
  tier,
  onTier,
  minScore,
  onMinScore,
  targetOnly,
  onTargetOnly,
  query,
  onQuery,
  depth,
  onDepth,
  onRescan,
  loading,
  targetPct,
  lastUpdated,
  scanned,
}) {
  return (
    <div className="surface space-y-3.5 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-1 rounded-xl border border-border/70 bg-secondary/40 p-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              type="button"
              onClick={() => onTimeframe(tf.value)}
              className={`num rounded-lg px-3 py-1.5 text-xs transition-colors ${
                timeframe === tf.value
                  ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <div className="flex flex-1 flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-end">
          <div className="relative sm:w-52">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Filter by symbol"
              className="h-9 pl-8 text-sm"
            />
          </div>

          <Select value={tier} onValueChange={onTier}>
            <SelectTrigger className="h-9 w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIERS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={depth} onValueChange={onDepth}>
            <SelectTrigger className="h-9 w-full sm:w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="40">Fast · 40</SelectItem>
              <SelectItem value="70">Standard · 70</SelectItem>
              <SelectItem value="110">Deep · 110</SelectItem>
            </SelectContent>
          </Select>

          <Button className="h-9" onClick={onRescan} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
            Rescan market
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border/60 pt-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 items-center gap-4">
          <div className="flex min-w-[190px] items-center gap-3">
            <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Min score</span>
            <Slider
              value={[minScore]}
              onValueChange={(v) => onMinScore(v[0])}
              min={0}
              max={95}
              step={1}
              className="w-28"
            />
            <span className="num text-xs">{minScore}</span>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={targetOnly} onCheckedChange={onTargetOnly} />
            Clears the {targetPct}% target bar
          </label>
        </div>

        <p className="text-[11px] text-muted-foreground">
          {scanned ? `${scanned} coins analysed` : 'Not scanned yet'}
          {lastUpdated ? ` · updated ${fmtClock(lastUpdated)}` : ''}
        </p>
      </div>
    </div>
  );
}