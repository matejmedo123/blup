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
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The passwords do not match.');
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
          title="This link is not active"
          body="Open the reset link from your email on this device. Links expire after an hour."
          actionLabel="Request a new link"
          onAction={() => router.replace('/(auth)/forgot-password')}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Body muted style={styles.intro}>Choose a new password for your account.</Body>

      {error ? <Notice tone="danger" title="Could not update" body={error} /> : null}

      <Input
        label="New password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        placeholder="At least 8 characters"
        editable={!loading}
      />
      <Input
        label="Confirm password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoComplete="new-password"
        editable={!loading}
        onSubmitEditing={submit}
      />

      <Button title="Save new password" onPress={submit} loading={loading} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: spacing.xl },
});
