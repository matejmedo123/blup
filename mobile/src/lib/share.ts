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

export function eventUrl(eventId: string): string {
  return `${(env.webUrl || 'https://blup.app').replace(/\/+$/, '')}/event/${eventId}`;
}

export interface ShareResult {
  shared: boolean;
  /** Set when the link was put on the clipboard instead of shared. */
  copied?: boolean;
}

export async function shareEvent(event: {
  id: string;
  title: string;
  whenLabel?: string;
}): Promise<ShareResult> {
  const url = eventUrl(event.id);
  const message = [event.title, event.whenLabel, url].filter(Boolean).join('\n');

  const result = await Share.share({ message, url, title: event.title });
  return { shared: result.action === Share.sharedAction };
}
