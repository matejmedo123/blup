import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { handleAuthDeepLink } from '@/auth/api';
import { Button, EmptyState, LoadingState, Notice, Screen } from '@/components/ui';

/**
 * Landing route for the links Supabase emails out — email confirmation and
 * OAuth callbacks.
 *
 * On native the deep-link handler in app/_layout.tsx catches these, but on web
 * the browser navigates to the URL directly and expo-router needs a real route:
 * without this file the confirmation link lands on "Unmatched Route" even though
 * the account was created.
 *
 * Supabase reports failures as `?error=...&error_code=...`, so a stale or reused
 * link gets a proper explanation instead of a blank page.
 */
const ERROR_MESSAGES: Record<string, string> = {
  otp_expired:
    'This link has expired or was already used. Request a new one and open it within the hour.',
  access_denied: 'This link is no longer valid.',
  invalid_request: 'This link is malformed. Try requesting a new email.',
};

export default function AuthCallbackScreen() {
  const params = useLocalSearchParams<{
    code?: string;
    error?: string;
    error_code?: string;
    error_description?: string;
  }>();

  const [status, setStatus] = useState<'working' | 'error'>('working');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // Supabase puts the details in the query string, the hash, or both.
    const href =
      Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.href : null;
    const hash = href ? new URL(href).hash.replace(/^#/, '') : '';
    const hashParams = new URLSearchParams(hash);

    const errorCode = params.error_code ?? hashParams.get('error_code') ?? undefined;
    const error = params.error ?? hashParams.get('error') ?? undefined;

    if (error || errorCode) {
      setMessage(
        ERROR_MESSAGES[errorCode ?? ''] ??
          params.error_description?.replace(/\+/g, ' ') ??
          'This link could not be used.',
      );
      setStatus('error');
      return;
    }

    // No error: exchange the code for a session, then continue into the app.
    const url = href ?? `blup://auth/callback?code=${params.code ?? ''}`;

    handleAuthDeepLink(url)
      .then(() => router.replace('/'))
      .catch((caught) => {
        setMessage(caught instanceof Error ? caught.message : 'Could not complete sign-in.');
        setStatus('error');
      });
  }, [params.code, params.error, params.error_code, params.error_description]);

  if (status === 'working') {
    return <Screen><LoadingState label="Confirming…" /></Screen>;
  }

  return (
    <Screen scroll>
      <Notice tone="warning" title="This link did not work" body={message ?? ''} />

      <EmptyState
        emoji="✉️"
        title="Nothing is lost"
        body="Your account still exists — the link is just single-use and short-lived. Sign in, or request a fresh email."
        actionLabel="Go to sign in"
        onAction={() => router.replace('/(auth)/sign-in')}
      />

      <Button
        title="Request a new link"
        variant="ghost"
        onPress={() => router.replace('/(auth)/forgot-password')}
      />
    </Screen>
  );
}
