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
      setError('Enter the email address you signed up with.');
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
          title="Check your inbox"
          body={`We sent a reset link to ${email.trim()}. Open it on this device and you will land back in BLUP.`}
        />
        <Button title="Back to sign in" variant="secondary" onPress={() => router.replace('/(auth)/sign-in')} />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Body muted style={styles.intro}>
        Enter your email and we will send you a link to set a new password.
      </Body>

      {error ? <Notice tone="danger" title="Could not send the email" body={error} /> : null}

      <Input
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
        editable={!loading}
        onSubmitEditing={submit}
      />

      <Button title="Send reset link" onPress={submit} loading={loading} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: spacing.xl },
});
