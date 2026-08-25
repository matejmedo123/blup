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
 * The comment above still holds — Nominatim asks for at most one request a
 * second — so this is not called per keystroke. The caller debounces, and the
 * request is abortable so a suggestion list never arrives for text that has
 * already been replaced.
 */
export async function suggestAddresses(
  query: string,
  options: { countryCodes?: string; signal?: AbortSignal; limit?: number } = {},
): Promise<GeocodeHit[]> {
  const q = query.trim();
  if (q.length < 4) return [];

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(options.limit ?? 5));
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
