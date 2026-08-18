import React, { useState } from 'react';
import { StyleSheet } from 'react-native';
import { router } from 'expo-router';

import { updatePassword } from '@/auth/api';
import { useAuth } from '@/auth/AuthProvider';
import { messageFor } from '@/lib/errors';
import { Body, Button, Input, Notice, Screen } from '@/components/ui';
import { spacing } from '@/theme';

/**
 * Reached through the emailed reset link. By the time this renders, the deep
 * link handler in app/_layout.tsx has already exchanged the code for a session,
 * so updateUser() is authorised.
 */
export default function ResetPasswordScreen() {
  const { isAuthenticated } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError(null);

    if (password.length < 8) {
      setError('Použi aspoň 8 znakov.');
      return;
    }
    if (password !== confirm) {
      setError('Heslá sa nezhodujú.');
      return;
    }

    setLoading(true);
    try {
      await updatePassword(password);
      router.replace('/');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <Screen scroll>
        <Notice
          tone="warning"
          title="Tento odkaz už neplatí"
          body="Otvor odkaz z e-mailu na tomto zariadení. Odkazy platia hodinu."
          actionLabel="Request a new link"
          onAction={() => router.replace('/(auth)/forgot-password')}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Body muted style={styles.intro}>Choose a new password for your account.</Body>

      {error ? <Notice tone="danger" title="Nepodarilo sa uložiť" body={error} /> : null}

      <Input
        label="Nové heslo"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        placeholder="Aspoň 8 znakov"
        editable={!loading}
      />
      <Input
        label="Heslo znova"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoComplete="new-password"
        editable={!loading}
        onSubmitEditing={submit}
      />

      <Button title="Uložiť nové heslo" onPress={submit} loading={loading} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: spacing.xl },
});
