/**
 * POST /functions/v1/gif-search
 *
 * GIF search for the chat composer, proxied through here so the provider key
 * stays in the Edge Function environment. A key shipped inside the app is a key
 * anybody can pull out of the bundle and spend, and Tenor's own terms require
 * the request to identify the integration rather than the end user — both of
 * which are reasons the call cannot be made from the client.
 *
 * With no key configured it answers `configured: false` and an empty list
 * rather than an error, so the picker can say plainly that GIF search is not
 * set up on this deployment while "attach your own GIF" carries on working.
 * That is the difference between a feature that is honest about being off and
 * a button that does nothing.
 *
 * Nothing is stored here. The chosen GIF's URL is handed back to the app, which
 * downloads it and puts a copy in the conversation's own private bucket — a
 * message that points at somebody else's CDN stops being a message the day
 * that CDN changes its mind.
 */
import {
  ApiError, errorResponse, handleOptions, json, rateLimit, readJson, requireUser,
} from '../_shared/http.ts';
import { configured, env } from '../_shared/env.ts';

interface SearchBody {
  query?: string;
  limit?: number;
  /** Tenor's paging cursor, passed straight back from a previous answer. */
  cursor?: string;
}

interface Gif {
  id: string;
  /** The animation itself, for sending. */
  url: string;
  /** A smaller, still-animated copy for the grid. */
  preview_url: string;
  width: number;
  height: number;
  description: string;
}

/** Tenor's shape, narrowed to the two formats we ask for. */
interface TenorResult {
  id?: string;
  content_description?: string;
  media_formats?: Record<string, { url?: string; dims?: number[] }>;
}

function shape(results: TenorResult[]): Gif[] {
  return results.flatMap((result) => {
    const full = result.media_formats?.tinygif ?? result.media_formats?.gif;
    const preview = result.media_formats?.nanogif ?? full;
    if (!full?.url || !result.id) return [];

    const [width, height] = full.dims ?? [200, 200];
    return [{
      id: result.id,
      url: full.url,
      preview_url: preview?.url ?? full.url,
      width: width || 200,
      height: height || 200,
      description: result.content_description ?? 'GIF',
    }];
  });
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    // Signed in only. Search costs the project quota, so it is not something an
    // anonymous caller gets to spend on our behalf.
    const user = await requireUser(req);
    rateLimit(`gif:${user.id}`, 60, 60_000);

    if (!configured.gifSearch()) {
      return json({
        configured: false,
        reason: 'GIF_SEARCH_NOT_CONFIGURED',
        gifs: [],
        next: null,
      });
    }

    const body = await readJson<SearchBody>(req);
    const query = (body.query ?? '').trim().slice(0, 100);
    const limit = Math.min(Math.max(Number(body.limit) || 24, 1), 40);
    const cursor = (body.cursor ?? '').trim().slice(0, 100);

    const params = new URLSearchParams({
      key: env.tenorApiKey(),
      client_key: env.tenorClientKey(),
      limit: String(limit),
      media_filter: 'tinygif,nanogif,gif',
      contentfilter: 'medium',
      locale: 'sk_SK',
    });
    if (cursor) params.set('pos', cursor);

    // No query means "what is popular", which is what an empty picker should
    // open on rather than a blank grid.
    const endpoint = query
      ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&${params}`
      : `https://tenor.googleapis.com/v2/featured?${params}`;

    const response = await fetch(endpoint, { headers: { accept: 'application/json' } });

    if (!response.ok) {
      // Their outage is not our 500, and it is not an empty result either —
      // the picker says the search is unavailable and keeps the upload path.
      console.error('tenor responded', response.status, await response.text().catch(() => ''));
      throw new ApiError('GIF_SEARCH_UNAVAILABLE', 'GIF search is temporarily unavailable', 502);
    }

    const payload = await response.json() as { results?: TenorResult[]; next?: string };

    return json({
      configured: true,
      gifs: shape(payload.results ?? []),
      next: payload.next || null,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
