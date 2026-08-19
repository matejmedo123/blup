import { env } from '@/lib/env';

/**
 * Sharing an event, in a browser.
 *
 * `navigator.share` exists on phones and on Safari; everywhere else there is no
 * share sheet at all, so the link goes on the clipboard instead and the caller
 * says so. React Native's Share is a no-op on web — using it would produce a
 * button that appears to work and does nothing.
 */

export function eventUrl(eventId: string): string {
  return `${(env.webUrl || window.location.origin).replace(/\/+$/, '')}/event/${eventId}`;
}

export interface ShareResult {
  shared: boolean;
  copied?: boolean;
}

export async function shareEvent(event: {
  id: string;
  title: string;
  whenLabel?: string;
}): Promise<ShareResult> {
  const url = eventUrl(event.id);
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
