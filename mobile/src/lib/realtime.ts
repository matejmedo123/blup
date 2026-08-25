import { supabase } from './supabase';

/**
 * Live table changes, subscribed the one safe way.
 *
 * The bug this exists to prevent, in full, because it cost a lot of blank
 * pages: `supabase.channel(topic)` hands back an *existing* channel when one
 * with that topic is still registered, and `removeChannel()` is asynchronous —
 * it waits for the server to acknowledge the unsubscribe. So a screen that
 * subscribes on mount and removes on unmount can, on a quick remount, be handed
 * its own previous channel, already subscribed. Adding a listener to that
 * throws:
 *
 *   cannot add `postgres_changes` callbacks for realtime:home-events
 *   after `subscribe()`
 *
 * That throw happens inside an effect, which takes the whole tree down — the
 * blank page that a reload always "fixed", because a reload builds a new client
 * with no channels in it.
 *
 * The fix is to never reuse a topic: every subscription gets its own, so a
 * channel on its way out can never be handed to the screen coming in. Nothing
 * in the app should call `supabase.channel()` directly; scripts/smoke-realtime-
 * remount.mjs fails the build if anything does.
 */
let sequence = 0;

export interface TableSubscription {
  /** A readable prefix, e.g. 'home-events'. Made unique per subscription. */
  topic: string;
  table: string;
  /** PostgREST filter, e.g. `event_id=eq.${id}`. */
  filter?: string;
  event?: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  onChange: () => void;
}

/** Returns the unsubscribe function an effect should give back. */
export function subscribeToTable(options: TableSubscription): () => void {
  sequence += 1;

  const channel = supabase
    .channel(`${options.topic}-${sequence}`)
    .on(
      'postgres_changes',
      {
        event: options.event ?? '*',
        schema: 'public',
        table: options.table,
        ...(options.filter ? { filter: options.filter } : {}),
      },
      () => options.onChange(),
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
