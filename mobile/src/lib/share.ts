import { Share } from 'react-native';

import { env } from '@/lib/env';

/**
 * Sharing an event.
 *
 * The link is always an https URL to the web page, never a `blup://` scheme.
 * A custom scheme is useless in a browser and worse than useless in a chat: on
 * a phone without the app installed it opens nothing at all. An https link
 * opens the app through universal links when it is installed, and the web page
 * when it is not.
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
  return `${(env.webUrl || 'https://blup.app').replace(/\/+$/, '')}/event/${ref}`;
}

export interface ShareResult {
  shared: boolean;
  /** Set when the link was put on the clipboard instead of shared. */
  copied?: boolean;
}

export async function shareEvent(event: {
  id: string;
  slug?: string | null;
  title: string;
  whenLabel?: string;
}): Promise<ShareResult> {
  const url = eventUrl(event);
  const message = [event.title, event.whenLabel, url].filter(Boolean).join('\n');

  const result = await Share.share({ message, url, title: event.title });
  return { shared: result.action === Share.sharedAction };
}
