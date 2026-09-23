import { callFunction } from '@/lib/supabase';

/**
 * GIF search.
 *
 * The provider key lives in the Edge Function environment and never in this
 * bundle — a key shipped in an app is a key anybody can lift out of it and
 * spend. So the app asks our own function, which asks Tenor.
 *
 * `configured: false` is a real answer, not an error. A deployment with no key
 * still sends GIFs — you pick one from your own library — and the picker says
 * so plainly rather than showing a search box that returns nothing for ever.
 */
export interface Gif {
  id: string;
  /** The animation itself, which is what gets sent. */
  url: string;
  /** A smaller, still animated copy, for the grid. */
  preview_url: string;
  width: number;
  height: number;
  description: string;
}

export interface GifSearchResult {
  configured: boolean;
  gifs: Gif[];
  next: string | null;
  reason?: string;
}

export async function searchGifs(params: {
  query?: string;
  limit?: number;
  cursor?: string | null;
} = {}): Promise<GifSearchResult> {
  const result = await callFunction<GifSearchResult>('gif-search', {
    query: params.query ?? '',
    limit: params.limit ?? 24,
    cursor: params.cursor ?? undefined,
  });

  return {
    configured: Boolean(result?.configured),
    gifs: result?.gifs ?? [],
    next: result?.next ?? null,
    reason: result?.reason,
  };
}
