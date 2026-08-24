import * as WebBrowser from 'expo-web-browser';

/**
 * Sends the user to a URL that belongs to somebody else — Stripe onboarding,
 * a bank's KYC form — and comes back to us afterwards.
 *
 * On a phone this is an in-app browser: the app stays alive underneath and the
 * return URL brings the user straight back.
 */
export async function openExternal(url: string): Promise<void> {
  await WebBrowser.openBrowserAsync(url);
}
