import { supabase } from '@/lib/supabase';

/**
 * BLUP SWAP — vlastné hľadanie.
 *
 * Nie je to hľadanie BLUPu s filtrom. Kladie inú otázku:
 *
 *   BLUP  „čo sa deje?" — všetky nadchádzajúce eventy, aj tie, na ktoré sa
 *         vstupenky nikdy nepredávali.
 *
 *   SWAP  „kde sa dá kúpiť vstupenka od niekoho?" — len to, na čo niekto
 *         PRÁVE TERAZ niečo ponúka. Event bez jedinej ponuky by viedol na
 *         prázdnu obrazovku.
 *
 * Iné je aj poradie. BLUP radí podľa času a vzdialenosti; SWAP podľa toho,
 * kde sa dá najviac vybrať a kde sú overené vstupenky.
 */
export type SwapHitKind = 'artist' | 'city' | 'venue' | 'event';

export interface SwapHit {
  kind: SwapHitKind;
  key: string;
  label: string;
  sublabel: string | null;
  image_url: string | null;
  event_id: string | null;
  start_at: string | null;
  listing_count: number;
  ticket_count: number;
  from_cents: number | null;
  currency: string | null;
  /** Koľko z toho sú vstupenky vydané BLUPom, teda overiteľné. */
  verified_count: number;
}

export interface SwapEvent {
  event_id: string;
  title: string;
  city: string | null;
  venue_name: string | null;
  start_at: string;
  cover_image_url: string | null;
  listing_count: number;
  ticket_count: number;
  from_cents: number | null;
  currency: string | null;
  verified_count: number;
}

/**
 * @param query prázdny reťazec je v poriadku — je to prvé otvorenie SWAPu,
 *              keď človek ešte nič nenapísal, a vtedy sa ukáže všetko.
 */
export async function swapSearch(query: string, limit = 30): Promise<SwapHit[]> {
  const { data, error } = await supabase.rpc('swap_search', {
    p_query: query.trim(),
    p_limit: limit,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as SwapHit[]) : [];
}

export async function swapEventsFor(
  kind: SwapHitKind,
  key: string,
  limit = 40,
): Promise<SwapEvent[]> {
  const { data, error } = await supabase.rpc('swap_events_for', {
    p_kind: kind,
    p_key: key,
    p_limit: limit,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as SwapEvent[]) : [];
}
