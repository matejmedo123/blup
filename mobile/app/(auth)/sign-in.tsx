import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, router } from 'expo-router';

import { signInWithApple, signInWithEmail, signInWithOAuth } from '@/auth/api';
import { messageFor } from '@/lib/errors';
import { Body, Button, Input, Mono, Notice, Screen } from '@/components/ui';
import { HeroBackground, Tagline, Wordmark } from '@/components/Wordmark';
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
      setError('Zadaj e-mail a heslo.');
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
      <HeroBackground>
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
              <Wordmark size={54} />
              <Tagline>Nechaj sa blupnúť.</Tagline>
              <Mono style={styles.subtitle}>eventy okolo teba · v reálnom čase</Mono>
            </View>

            {error ? <Notice tone="danger" title="Prihlásenie zlyhalo" body={error} /> : null}

            <Input
              label="E-mail"
              value={email}
              onChangeText={setEmail}
              placeholder="ty@example.com"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              editable={!loading}
            />

            <Input
              label="Heslo"
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

            <Button title="Prihlásiť sa" onPress={submit} loading={loading} />

            <Link href="/(auth)/forgot-password" asChild>
              <Text style={styles.link}>Zabudol si heslo?</Text>
            </Link>

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Mono style={styles.dividerText}>alebo</Mono>
              <View style={styles.dividerLine} />
            </View>

            {Platform.OS === 'ios' ? (
              <Button
                title="Cez Apple"
                icon=""
                variant="secondary"
                onPress={() => oauth('apple')}
                loading={oauthLoading === 'apple'}
                style={styles.oauthButton}
              />
            ) : null}

            <Button
              title="Cez Google"
              variant="secondary"
              onPress={() => oauth('google')}
              loading={oauthLoading === 'google'}
              style={styles.oauthButton}
            />

            <Body muted style={styles.oauthHint}>
              Prihlásenie cez sociálnu sieť vyžaduje zapnutého providera v tvojom Supabase projekte.
            </Body>

            <View style={styles.footer}>
              <Body muted>Nový na BLUPe? </Body>
              <Link href="/(auth)/sign-up" asChild>
                <Text style={styles.link}>Vytvor si účet</Text>
              </Link>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </HeroBackground>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.xl, paddingTop: spacing.xxxl, flexGrow: 1 },
  header: { alignItems: 'center', marginBottom: spacing.xxxl },
  subtitle: { color: colors.textTertiary, marginTop: spacing.sm },

  link: {
    ...typography.captionStrong,
    color: colors.accentText,
    textAlign: 'center',
    marginTop: spacing.lg,
  },

  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.xl, gap: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.textTertiary },

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
