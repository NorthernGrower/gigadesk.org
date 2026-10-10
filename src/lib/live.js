import { base44 } from '@/api/base44Client';

/**
 * Runs `onChange` (debounced) whenever any Trade record is created, updated or
 * deleted, so stats and lists refresh live without waiting for a bot cycle.
 * Returns an unsubscribe function for the effect cleanup.
 */
export function onTradesChange(onChange, debounceMs = 2000) {
  let timer = null;
  const fire = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };
  const unsubscribe = base44.entities.Trade.subscribe(fire);
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}