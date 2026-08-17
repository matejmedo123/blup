import React, { useState } from 'react';
import { useLocalSearchParams, router } from 'expo-router';

import { resendConfirmationEmail } from '@/auth/api';
import { messageFor } from '@/lib/errors';
import { Button, EmptyState, Notice, Screen } from '@/components/ui';

export default function VerifyEmailScreen() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const resend = async () => {
    if (!email) return;
    setLoading(true);
    setStatus(null);
    try {
      await resendConfirmationEmail(email);
      setStatus({ tone: 'success', message: 'Sent again. It can take a minute to arrive.' });
    } catch (caught) {
      setStatus({ tone: 'danger', message: messageFor(caught) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen scroll>
      {status ? (
        <Notice
          tone={status.tone}
          title={status.tone === 'success' ? 'Email sent' : 'Could not resend'}
          body={status.message}
        />
      ) : null}

      <EmptyState
        emoji="📬"
        title="Confirm your email"
        body={
          email
            ? `We sent a confirmation link to ${email}. Tap it on this device and BLUP will open with you signed in.`
            : 'We sent you a confirmation link. Tap it on this device to finish signing up.'
        }
        actionLabel={email ? 'Resend the email' : undefined}
        onAction={email ? resend : undefined}
      />

      <Button
        title="Back to sign in"
        variant="ghost"
        loading={loading}
        onPress={() => router.replace('/(auth)/sign-in')}
      />
    </Screen>
  );
}
