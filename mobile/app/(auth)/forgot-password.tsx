import React, { useState } from 'react';
import { StyleSheet } from 'react-native';
import { router } from 'expo-router';

import { sendPasswordReset } from '@/auth/api';
import { messageFor } from '@/lib/errors';
import { Body, Button, Input, Notice, Screen } from '@/components/ui';
import { spacing } from '@/theme';

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError(null);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Zadaj e-mail, s ktorým si sa registroval.');
      return;
    }

    setLoading(true);
    try {
      await sendPasswordReset(email);
      setSent(true);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <Screen scroll>
        <Notice
          tone="success"
          title="Pozri si schránku"
          body={`Poslali sme odkaz na obnovu na ${email.trim()}. Otvor ho na tomto zariadení a vrátiš sa späť do BLUPu.`}
        />
        <Button title="Späť na prihlásenie" variant="secondary" onPress={() => router.replace('/(auth)/sign-in')} />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Body muted style={styles.intro}>
        Zadaj e-mail a pošleme ti odkaz na nastavenie nového hesla.
      </Body>

      {error ? <Notice tone="danger" title="E-mail sa nepodarilo poslať" body={error} /> : null}

      <Input
        label="E-mail"
        value={email}
        onChangeText={setEmail}
        placeholder="ty@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
        editable={!loading}
        onSubmitEditing={submit}
      />

      <Button title="Poslať odkaz" onPress={submit} loading={loading} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: spacing.xl },
});
