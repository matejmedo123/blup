/**
 * Turning a typed address into a point on the map.
 *
 * Uses Nominatim, OpenStreetMap's own geocoder: no key, no account, and no
 * per-request cost — which matters because this runs while someone is still
 * deciding whether to publish anything at all.
 *
 * It is called on an explicit tap rather than on every keystroke. Nominatim
 * asks for at most one request a second and we are not going to spend that
 * budget on someone typing "Nám" three characters at a time; a button also
 * makes it obvious that the pin is about to move, which typing does not.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/**
 * Photon — the same OpenStreetMap data, but an endpoint built for type-ahead.
 *
 * Nominatim is a geocoder: it is tuned for resolving a whole address once, asks
 * callers for at most a request a second, and answers in its own time. Used for
 * suggestions behind a 500 ms debounce it meant roughly a second and a half
 * between the last keystroke and the first row — which reads as "the search is
 * broken", and people started clicking the map instead.
 *
 * Photon is Komoot's autocomplete service over the same data: no key, CORS
 * open, and built to answer partial words. Nominatim stays for `geocodeAddress`,
 * where the full structured address matters more than the milliseconds, and as
 * the fallback here if Photon is unreachable.
 */
const SUGGEST_ENDPOINT = 'https://photon.komoot.io/api/';

/** A slow suggestion is a useless suggestion — the letters have moved on. */
const SUGGEST_TIMEOUT_MS = 3500;

/**
 * Answers we already have.
 *
 * Typing is not monotonic: people overshoot and backspace, and every backspace
 * used to be a fresh round trip for a query we had just answered. Bounded so a
 * long session cannot grow it without limit.
 */
const cache = new Map<string, GeocodeHit[]>();
const CACHE_MAX = 120;

function cacheKey(query: string, near?: { latitude: number; longitude: number } | null): string {
  const bias = near ? `@${near.latitude.toFixed(1)},${near.longitude.toFixed(1)}` : '';
  return `${query.trim().toLowerCase()}${bias}`;
}

function remember(key: string, hits: GeocodeHit[]): void {
  if (cache.size >= CACHE_MAX) {
    // Oldest first: a Map iterates in insertion order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, hits);
}

/** What we already know for this query, if anything. Never a request. */
export function cachedSuggestions(
  query: string,
  near?: { latitude: number; longitude: number } | null,
): GeocodeHit[] | null {
  return cache.get(cacheKey(query, near)) ?? null;
}

export interface GeocodeHit {
  latitude: number;
  longitude: number;
  /** What the geocoder thinks this is, so the organizer can see it got the right street. */
  label: string;
  city: string | null;
}


/**
 * A Slovak address, written the way Slovak writes it.
 *
 * Nominatim's `display_name` leads with the house number and then walks the
 * whole administrative chain — "13, Mostná, Staré Mesto, Nitra, Nitriansky
 * kraj, 949 01, Slovensko". Nobody writes an address like that, and in a list
 * of suggestions the useful part is buried. Rebuilt from the parts it also
 * returns: street first, then the number, then the town.
 */
function slovakAddress(
  parts: Record<string, string> | undefined,
  fallback: string,
): string {
  const a = parts ?? {};
  const street = a.road ?? a.pedestrian ?? a.footway ?? a.square ?? null;
  const number = a.house_number ?? null;
  const place =
    a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb ?? a.county ?? null;

  const line = [street, number].filter(Boolean).join(' ');
  const label = [line || a.name || null, place].filter(Boolean).join(', ');

  // Nothing recognisable — better the geocoder's own words than an empty row.
  return label || fallback;
}

export async function geocodeAddress(
  query: string,
  options: { countryCodes?: string; signal?: AbortSignal } = {},
): Promise<GeocodeHit | null> {
  const q = query.trim();
  if (q.length < 4) return null;

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '1');
  // Slovakia and its neighbours, so "Hlavná 1" lands on the right Hlavná.
  url.searchParams.set('countrycodes', options.countryCodes ?? 'sk,cz,at,hu,pl');
  url.searchParams.set('accept-language', 'sk');

  const response = await fetch(url.toString(), {
    signal: options.signal,
    headers: {
      // Nominatim's policy requires identifying the application.
      'User-Agent': 'BLUP/1.0 (https://blup.sk)',
      Accept: 'application/json',
    },
  });

  if (!response.ok) throw new Error('Vyhľadávanie adresy sa nepodarilo. Skús to o chvíľu.');

  const results = (await response.json()) as Array<{
    lat: string;
    lon: string;
    display_name?: string;
    address?: Record<string, string>;
  }>;

  const hit = results[0];
  if (!hit) return null;

  const latitude = Number(hit.lat);
  const longitude = Number(hit.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const a = hit.address ?? {};
  return {
    latitude,
    longitude,
    label: slovakAddress(hit.address, hit.display_name ?? q),
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? null,
  };
}

/**
 * Address suggestions while somebody types.
 *
 * Fast path first (Photon, built for this), Nominatim only if that fails. Both
 * are abortable, and the answer is cached so backspacing costs nothing.
 *
 * `near` biases the ranking towards where the person is. It is the difference
 * between "Hlavná" offering the Hlavná three streets away and offering the one
 * in another country, and it makes the right row land first instead of fourth —
 * which feels faster than any millisecond saved on the wire.
 */
export async function suggestAddresses(
  query: string,
  options: {
    countryCodes?: string;
    signal?: AbortSignal;
    limit?: number;
    near?: { latitude: number; longitude: number } | null;
  } = {},
): Promise<GeocodeHit[]> {
  const q = query.trim();
  // Three, not four: "Nit" is already a useful thing to ask about, and the
  // fourth letter was a whole extra round trip's worth of waiting.
  if (q.length < 3) return [];

  const key = cacheKey(q, options.near);
  const known = cache.get(key);
  if (known) return known;

  const limit = options.limit ?? 5;

  try {
    const hits = await suggestViaPhoton(q, { ...options, limit });
    if (hits.length > 0) {
      remember(key, hits);
      return hits;
    }
  } catch (caught) {
    // An abort is the caller replacing the query, not a failure to report.
    if ((caught as { name?: string })?.name === 'AbortError') throw caught;
  }

  const fallback = await suggestViaNominatim(q, { ...options, limit });
  remember(key, fallback);
  return fallback;
}

/** Komoot's Photon: GeoJSON, one feature per suggestion. */
async function suggestViaPhoton(
  q: string,
  options: {
    signal?: AbortSignal;
    limit: number;
    near?: { latitude: number; longitude: number } | null;
  },
): Promise<GeocodeHit[]> {
  const url = new URL(SUGGEST_ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(options.limit));
  if (options.near) {
    url.searchParams.set('lat', String(options.near.latitude));
    url.searchParams.set('lon', String(options.near.longitude));
  }

  // Its own deadline on top of the caller's abort: a request that outlives the
  // typing is worse than no request, because the list it fills is already wrong.
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), SUGGEST_TIMEOUT_MS);
  const signals = [options.signal, timer.signal].filter(Boolean) as AbortSignal[];

  try {
    const response = await fetch(url.toString(), {
      signal: anySignal(signals),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];

    const body = (await response.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: Record<string, string>;
      }>;
    };

    const hits: GeocodeHit[] = [];
    for (const feature of body.features ?? []) {
      const coordinates = feature.geometry?.coordinates;
      if (!coordinates) continue;
      const [longitude, latitude] = coordinates;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

      const p = feature.properties ?? {};
      // Photon names the parts differently from Nominatim; slovakAddress only
      // needs road/house_number/city, so they are mapped rather than reformatted
      // in a second place.
      const label = slovakAddress(
        {
          road: p.street ?? p.name ?? '',
          house_number: p.housenumber ?? '',
          city: p.city ?? p.town ?? p.village ?? p.county ?? '',
          name: p.name ?? '',
        },
        p.name ?? q,
      );

      hits.push({
        latitude,
        longitude,
        label,
        city: p.city ?? p.town ?? p.village ?? p.county ?? null,
      });
    }
    return hits;
  } finally {
    clearTimeout(timeout);
  }
}

/** The original path, kept as the fallback. */
async function suggestViaNominatim(
  q: string,
  options: { countryCodes?: string; signal?: AbortSignal; limit: number },
): Promise<GeocodeHit[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(options.limit));
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', options.countryCodes ?? 'sk,cz,at,hu,pl');
  url.searchParams.set('accept-language', 'sk');

  const response = await fetch(url.toString(), {
    signal: options.signal,
    headers: {
      'User-Agent': 'BLUP/1.0 (https://blup.sk)',
      Accept: 'application/json',
    },
  });

  if (!response.ok) return [];

  const results = (await response.json()) as Array<{
    lat: string;
    lon: string;
    display_name?: string;
    address?: Record<string, string>;
  }>;

  const hits: GeocodeHit[] = [];

  for (const hit of results) {
    const latitude = Number(hit.lat);
    const longitude = Number(hit.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    const a = hit.address ?? {};
    hits.push({
      latitude,
      longitude,
      label: slovakAddress(hit.address, hit.display_name ?? q),
      city: a.city ?? a.town ?? a.village ?? a.municipality ?? null,
    });
  }

  return hits;
}

/**
 * One signal that fires when any of them does.
 *
 * `AbortSignal.any` is not in every runtime this ships to (Hermes on an older
 * phone), so it is used when present and hand-rolled when not.
 */
function anySignal(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];

  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === 'function') return native(signals);

  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
