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
    'Tento odkaz vypršal alebo už bol použitý. Vyžiadaj si nový a otvor ho do hodiny.',
  access_denied: 'Tento odkaz už neplatí.',
  invalid_request: 'Tento odkaz je poškodený. Skús si vyžiadať nový e-mail.',
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
          'Tento odkaz sa nedal použiť.',
      );
      setStatus('error');
      return;
    }

    // No error: exchange the code for a session, then continue into the app.
    const url = href ?? `blup://auth/callback?code=${params.code ?? ''}`;

    handleAuthDeepLink(url)
      .then(() => router.replace('/'))
      .catch((caught) => {
        setMessage(caught instanceof Error ? caught.message : 'Prihlásenie sa nepodarilo dokončiť.');
        setStatus('error');
      });
  }, [params.code, params.error, params.error_code, params.error_description]);

  if (status === 'working') {
    return <Screen><LoadingState label="Potvrdzujem…" /></Screen>;
  }

  return (
    <Screen scroll>
      <Notice tone="warning" title="Tento odkaz nefungoval" body={message ?? ''} />

      <EmptyState
        emoji="✉️"
        title="Nič nie je stratené"
        body="Tvoj účet stále existuje — odkaz je len jednorazový a krátko platný. Prihlás sa alebo si vyžiadaj nový e-mail."
        actionLabel="Prejsť na prihlásenie"
        onAction={() => router.replace('/(auth)/sign-in')}
      />

      <Button
        title="Vyžiadať nový odkaz"
        variant="ghost"
        onPress={() => router.replace('/(auth)/forgot-password')}
      />
    </Screen>
  );
}
