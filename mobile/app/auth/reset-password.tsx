import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';

import { handleAuthDeepLink } from '@/auth/api';
import { LoadingState, Screen } from '@/components/ui';

/**
 * The password-reset email points at /auth/reset-password. The actual form
 * lives at (auth)/reset-password; this route exists so the emailed URL resolves
 * on web, exchanges the code for a session, and then hands over to the form.
 */
export default function AuthResetPasswordRedirect() {
  useEffect(() => {
    const href =
      Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.href : null;

    const go = () => router.replace('/(auth)/reset-password');

    if (!href) {
      go();
      return;
    }

    // A failed exchange is not fatal: the form itself explains an invalid link.
    handleAuthDeepLink(href).then(go).catch(go);
  }, []);

  return <Screen><LoadingState label="Opening…" /></Screen>;
}
