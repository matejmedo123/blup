import { env } from '@/lib/env';

/**
 * Sharing an event, in a browser.
 *
 * `navigator.share` exists on phones and on Safari; everywhere else there is no
 * share sheet at all, so the link goes on the clipboard instead and the caller
 * says so. React Native's Share is a no-op on web — using it would produce a
 * button that appears to work and does nothing.
 */

/**
 * The link people actually paste into a chat.
 *
 * The readable slug, not the uuid — a shared link is the first thing anybody
 * sees of an event, and `/event/2bb8e298-2fbe-…` says nothing about it. The
 * uuid still resolves, so old links keep working; it is just no longer what we
 * hand out.
 */
export function eventUrl(event: { id: string; slug?: string | null } | string): string {
  const ref = typeof event === 'string' ? event : event.slug || event.id;
  return `${(env.webUrl || window.location.origin).replace(/\/+$/, '')}/event/${ref}`;
}

export interface ShareResult {
  shared: boolean;
  copied?: boolean;
}

export async function shareEvent(event: {
  id: string;
  slug?: string | null;
  title: string;
  whenLabel?: string;
}): Promise<ShareResult> {
  const url = eventUrl(event);
  const text = [event.title, event.whenLabel].filter(Boolean).join(' · ');

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: event.title, text, url });
      return { shared: true };
    } catch (error) {
      // AbortError is the user closing the sheet, which is not a failure.
      if ((error as Error)?.name === 'AbortError') return { shared: false };
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    return { shared: true, copied: true };
  } catch {
    return { shared: false };
  }
}
