import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';

import { signUpWithEmail } from '@/auth/api';
import { messageFor } from '@/lib/errors';
import { Body, Button, Input, Notice, Screen } from '@/components/ui';
import { spacing } from '@/theme';

export default function SignUpScreen() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const validate = (): boolean => {
    const errors: Record<string, string> = {};

    if (displayName.trim().length < 2) errors.displayName = 'Tell us what to call you.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'That email does not look right.';
    if (password.length < 8) errors.password = 'Use at least 8 characters.';
    if (password !== confirm) errors.confirm = 'The passwords do not match.';

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submit = async () => {
    setError(null);
    if (!validate()) return;

    setLoading(true);
    try {
      const result = await signUpWithEmail({
        email,
        password,
        displayName: displayName.trim(),
      });

      if (result.needsEmailConfirmation) {
        router.replace({ pathname: '/(auth)/verify-email', params: { email: email.trim() } });
      } else {
        // Email confirmation disabled in the project: straight into onboarding.
        router.replace('/(onboarding)/profile');
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen edges={['bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Body muted style={styles.intro}>
            One account gets you the map, your tickets and everything you save.
          </Body>

          {error ? <Notice tone="danger" title="Could not create the account" body={error} /> : null}

          <Input
            label="Name"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Alex Kováč"
            autoCapitalize="words"
            autoComplete="name"
            error={fieldErrors.displayName}
            editable={!loading}
          />

          <Input
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            error={fieldErrors.email}
            editable={!loading}
          />

          <Input
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="At least 8 characters"
            secureTextEntry
            autoComplete="new-password"
            error={fieldErrors.password}
            editable={!loading}
          />

          <Input
            label="Confirm password"
            value={confirm}
            onChangeText={setConfirm}
            placeholder="Type it again"
            secureTextEntry
            autoComplete="new-password"
            error={fieldErrors.confirm}
            editable={!loading}
            onSubmitEditing={submit}
          />

          <Button title="Create account" onPress={submit} loading={loading} />

          <Body muted style={styles.legal}>
            By creating an account you agree to the BLUP terms and privacy policy.
          </Body>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.xl },
  intro: { marginBottom: spacing.xl },
  legal: { textAlign: 'center', marginTop: spacing.lg, fontSize: 12 },
});
