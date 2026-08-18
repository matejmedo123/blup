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
      setStatus({ tone: 'success', message: 'Poslané znova. Doručenie môže chvíľu trvať.' });
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
          title={status.tone === 'success' ? 'E-mail odoslaný' : 'Nepodarilo sa poslať znova'}
          body={status.message}
        />
      ) : null}

      <EmptyState
        emoji="📬"
        title="Potvrď si e-mail"
        body={
          email
            ? `Poslali sme potvrdzovací odkaz na ${email}. Klikni naň na tomto zariadení a BLUP sa otvorí prihlásený.`
            : 'Poslali sme ti potvrdzovací odkaz. Klikni naň na tomto zariadení a registrácia sa dokončí.'
        }
        actionLabel={email ? 'Poslať e-mail znova' : undefined}
        onAction={email ? resend : undefined}
      />

      <Button
        title="Späť na prihlásenie"
        variant="ghost"
        loading={loading}
        onPress={() => router.replace('/(auth)/sign-in')}
      />
    </Screen>
  );
}
