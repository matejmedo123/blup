import { supabase } from '@/lib/supabase';
import type { SignalType } from '@/types/models';

/**
 * Behavioural signals feed the recommendation ranker (spec §9/§10).
 *
 * Signals are best-effort: a failure here must never break a user action, so
 * every call swallows its error and only logs in development. They are stored
 * per user under RLS — nobody but the user (and an admin) can read them.
 */
export async function recordSignal(
  eventId: string,
  signal: SignalType,
  context: Record<string, unknown> = {},
  weight = 1,
): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_signal', {
      p_event_id: eventId,
      p_signal: signal,
      p_weight: weight,
      p_context: context,
    });
    if (error) throw error;
  } catch (error) {
    if (__DEV__) console.warn(`Signal ${signal} not recorded:`, error);
  }
}

/** Batch impressions so scrolling a feed does not fire one request per card. */
const impressionQueue = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function queueImpression(eventId: string): void {
  impressionQueue.add(eventId);

  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const ids = [...impressionQueue];
    impressionQueue.clear();
    flushTimer = null;

    for (const id of ids) {
      void recordSignal(id, 'impression', { source: 'feed' }, 0.2);
    }
  }, 4000);
}
