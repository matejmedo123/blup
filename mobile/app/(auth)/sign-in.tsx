import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, router } from 'expo-router';

import { signInWithApple, signInWithEmail, signInWithOAuth } from '@/auth/api';
import { messageFor } from '@/lib/errors';
import { Body, Button, Input, Notice, Screen } from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

export default function SignInScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

  const submit = async () => {
    setError(null);

    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }

    setLoading(true);
    try {
      await signInWithEmail(email, password);
      router.replace('/');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(false);
    }
  };

  const oauth = async (provider: 'apple' | 'google') => {
    setError(null);
    setOauthLoading(provider);
    try {
      if (provider === 'apple' && Platform.OS === 'ios') {
        await signInWithApple();
      } else {
        await signInWithOAuth(provider);
      }
      router.replace('/');
    } catch (caught) {
      const message = messageFor(caught);
      // A user backing out of the system sheet is not an error worth shouting about.
      if (!/cancel/i.test(message)) setError(message);
    } finally {
      setOauthLoading(null);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.logo}>BLUP</Text>
            <Text style={styles.tagline}>What’s your next Blup?</Text>
          </View>

          {error ? <Notice tone="danger" title="Could not sign in" body={error} /> : null}

          <Input
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            editable={!loading}
          />

          <Input
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            editable={!loading}
            onSubmitEditing={submit}
            returnKeyType="go"
          />

          <Button title="Sign in" onPress={submit} loading={loading} />

          <Link href="/(auth)/forgot-password" asChild>
            <Text style={styles.link}>Forgot your password?</Text>
          </Link>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          {Platform.OS === 'ios' ? (
            <Button
              title="Continue with Apple"
              icon=""
              variant="secondary"
              onPress={() => oauth('apple')}
              loading={oauthLoading === 'apple'}
              style={styles.oauthButton}
            />
          ) : null}

          <Button
            title="Continue with Google"
            variant="secondary"
            onPress={() => oauth('google')}
            loading={oauthLoading === 'google'}
            style={styles.oauthButton}
          />

          <Body muted style={styles.oauthHint}>
            Social sign-in needs the matching provider enabled in your Supabase project.
          </Body>

          <View style={styles.footer}>
            <Body muted>New to BLUP? </Body>
            <Link href="/(auth)/sign-up" asChild>
              <Text style={styles.link}>Create an account</Text>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.xl, paddingTop: spacing.xxxl, flexGrow: 1 },
  header: { alignItems: 'center', marginBottom: spacing.xxxl },
  logo: { ...typography.display, color: colors.accent, letterSpacing: 6, fontSize: 42 },
  tagline: { ...typography.body, color: colors.textSecondary, marginTop: spacing.sm },

  link: {
    ...typography.caption,
    color: colors.accent,
    textAlign: 'center',
    marginTop: spacing.lg,
  },

  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.xl, gap: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { ...typography.caption, color: colors.textTertiary },

  oauthButton: { marginBottom: spacing.md },
  oauthHint: { textAlign: 'center', fontSize: 12 },

  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 'auto',
    paddingTop: spacing.xxl,
  },
});
