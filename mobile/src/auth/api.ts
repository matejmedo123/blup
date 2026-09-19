import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

/**
 * Authentication API.
 *
 * Passwords are never handled by us beyond passing them to Supabase Auth over
 * TLS — no hashing, storing or logging happens in the app.
 */

const REDIRECT_TO = Linking.createURL('/auth/callback');
const RESET_REDIRECT_TO = Linking.createURL('/auth/reset-password');

export async function signUpWithEmail(params: {
  email: string;
  password: string;
  username?: string;
  displayName?: string;
}) {
  const { data, error } = await supabase.auth.signUp({
    email: params.email.trim().toLowerCase(),
    password: params.password,
    options: {
      emailRedirectTo: REDIRECT_TO,
      data: {
        username: params.username?.trim().toLowerCase(),
        display_name: params.displayName?.trim(),
      },
    },
  });

  if (error) throw error;

  return {
    user: data.user,
    session: data.session,
    // With email confirmation on, there is no session until the link is clicked.
    needsEmailConfirmation: !data.session && Boolean(data.user),
  };
}

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  // This device only. Supabase defaults to 'global', which revokes every
  // refresh token the account has — signing out here would also sign the same
  // person out on their phone and on the tab scanning tickets at the door.
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

export async function sendPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: RESET_REDIRECT_TO,
  });
  if (error) throw error;
}

export async function updatePassword(newPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function resendConfirmationEmail(email: string) {
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: REDIRECT_TO },
  });
  if (error) throw error;
}

/**
 * Native Sign in with Apple. Requires the Apple provider to be enabled in
 * Supabase Auth and an Apple Developer account for the Services ID.
 */
export async function signInWithApple() {
  if (Platform.OS !== 'ios') {
    throw new Error('Sign in with Apple is only available on iOS devices.');
  }

  const available = await AppleAuthentication.isAvailableAsync();
  if (!available) {
    throw new Error('Sign in with Apple is not available on this device.');
  }

  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });

  if (!credential.identityToken) {
    throw new Error('Apple did not return an identity token.');
  }

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
  });

  if (error) throw error;

  // Apple only sends the name on the very first authorization.
  if (credential.fullName?.givenName && data.user) {
    const displayName = [credential.fullName.givenName, credential.fullName.familyName]
      .filter(Boolean)
      .join(' ');
    await supabase.from('profiles').update({ display_name: displayName }).eq('id', data.user.id);
  }

  return data;
}

/**
 * Google (and any other OAuth provider) via PKCE.
 *
 * Native opens the system browser and waits for it to come back with a code.
 * A browser cannot do that: `openAuthSessionAsync` becomes a pop-up, pop-ups
 * are blocked by default when they are not opened directly inside a click, and
 * a blocked sign-in window looks to the user like a button that does nothing.
 * So on web the page navigates to the provider and comes back to
 * /auth/callback, which exchanges the code.
 *
 * Requires the provider to be enabled in the Supabase dashboard, and the
 * redirect URL to be on its allow-list.
 */
export async function signInWithOAuth(provider: 'google' | 'apple' | 'facebook') {
  if (Platform.OS === 'web') {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: REDIRECT_TO },
    });
    if (error) throw error;

    // supabase-js is navigating the page; nothing after this runs.
    return null;
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: REDIRECT_TO, skipBrowserRedirect: true },
  });

  if (error) throw error;
  if (!data.url) throw new Error('The provider did not return a sign-in URL.');

  const result = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT_TO);

  if (result.type !== 'success' || !result.url) {
    throw new Error('Sign-in was cancelled.');
  }

  // PKCE returns ?code=…, which we exchange for a session.
  const url = new URL(result.url);
  const code = url.searchParams.get('code');

  if (!code) throw new Error('No authorization code was returned.');

  const { data: sessionData, error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) throw exchangeError;
  return sessionData;
}

/** Handles the deep link that arrives after email confirmation / reset. */
export async function handleAuthDeepLink(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const code = parsed.searchParams.get('code');

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return true;
  }

  // Older implicit-flow links carry the tokens in the fragment.
  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(fragment);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');

  if (accessToken && refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) throw error;
    return true;
  }

  return false;
}
