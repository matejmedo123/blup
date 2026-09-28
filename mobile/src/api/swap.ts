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
  /**
   * Čo ide do adresy. Pri interpretovi, meste a mieste je to ich meno; pri
   * evente slug, a keď ho nemá, uuid.
   */
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
  /**
   * Čitateľná časť adresy, napríklad `hypeland`.
   *
   * Môže chýbať: eventy založené pred zavedením slugov ho nemajú a adresa sa
   * vtedy postaví z uuid. Na to je `swapRef()` nižšie — aby sa to nemuselo
   * rozhodovať na každom mieste, kde sa na SWAP odkazuje.
   */
  event_slug: string | null;
  title: string;
  city: string | null;
  venue_name: string | null;
  start_at: string;
  cover_image_url: string | null;
  /** Rozhoduje o gradiente, keď fotka chýba — rovnako ako na karte v BLUPe. */
  category: string | null;
  listing_count: number;
  ticket_count: number;
  from_cents: number | null;
  currency: string | null;
  verified_count: number;
}

/**
 * Čo sa má objaviť v adrese `/swap/…`.
 *
 * Slug, keď ho event má, inak uuid. Jedno miesto, nie rozhodovanie na každej
 * karte — inak jedna z nich ostane pri uuid a človek dostane raz čitateľný
 * odkaz a raz nečitateľný podľa toho, kde klikol.
 */
export function swapRef(event: { event_slug?: string | null; event_id: string }): string {
  return event.event_slug || event.event_id;
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

/**
 * Kategórie SWAPu.
 *
 * Iné než v BLUPe zámerne. BLUP triedi podľa nálady — Hudba, Outdoor,
 * Spiritualita — lebo odpovedá na „čo by som si dnes dal". Na vstupenku sa
 * podľa nálady nehľadá; hľadá sa podľa toho, na čo sa vôbec vstupenky
 * predávajú.
 */
export type SwapFamily = 'concert' | 'festival' | 'sport' | 'stage' | 'other';

export const SWAP_FAMILY_LABEL: Record<SwapFamily, string> = {
  concert: 'Koncerty',
  festival: 'Festivaly',
  sport: 'Šport',
  stage: 'Divadlo a kultúra',
  other: 'Ostatné',
};

export const SWAP_FAMILY_GLYPH: Record<SwapFamily, string> = {
  concert: '♪',
  festival: '✦',
  sport: '⚽',
  stage: '◈',
  other: '▣',
};

export interface SwapFamilyCount {
  key: SwapFamily;
  listing_count: number;
  ticket_count: number;
  from_cents: number | null;
  currency: string | null;
}

export interface SwapHome {
  total_listings: number;
  total_tickets: number;
  from_cents: number | null;
  currency: string | null;
  families: SwapFamilyCount[];
  /** Čo sa hrá najskôr — najnaliehavejšie pre obe strany. */
  soon: SwapEvent[];
  /** Kde je najviac na výber. */
  most: SwapEvent[];
  /** Kde sú overené BLUP vstupenky. */
  verified: SwapEvent[];
}

export async function getSwapHome(limit = 8): Promise<SwapHome> {
  const { data, error } = await supabase.rpc('swap_home', { p_limit: limit });
  if (error) throw error;
  return data as SwapHome;
}

/**
 * Ponuka SWAPu ako jeden zoznam.
 *
 * Domovská SWAPu je postavená rovnako ako domovská BLUPu: pás filtrov a pod
 * ním jeden zoznam eventov podľa dátumu. Tri kurátorské zoznamy pod sebou
 * vyzerali inak než zvyšok appky a ten istý event sa v nich objavil aj
 * trikrát.
 */
export async function swapEvents(
  family: SwapFamily | null,
  verifiedOnly = false,
  limit = 60,
): Promise<SwapEvent[]> {
  const { data, error } = await supabase.rpc('swap_events', {
    p_family: family ?? 'all',
    p_verified_only: verifiedOnly,
    p_limit: limit,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as SwapEvent[]) : [];
}

export async function swapEventsInFamily(
  family: SwapFamily,
  limit = 40,
): Promise<SwapEvent[]> {
  const { data, error } = await supabase.rpc('swap_events_in_family', {
    p_family: family,
    p_limit: limit,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as SwapEvent[]) : [];
}
