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
    label: hit.display_name ?? q,
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? null,
  };
}
