import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';

import { signUpWithEmail } from '@/auth/api';
import { messageFor } from '@/lib/errors';
import { Body, Button, Caption, Input, Notice, Screen } from '@/components/ui';
import { colors, spacing } from '@/theme';

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

    if (displayName.trim().length < 2) errors.displayName = 'Napíš, ako ťa máme volať.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Tento e-mail nevyzerá správne.';
    if (password.length < 8) errors.password = 'Použi aspoň 8 znakov.';
    if (password !== confirm) errors.confirm = 'Heslá sa nezhodujú.';

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
            Jeden účet ti otvorí mapu, tvoje vstupenky aj všetko, čo si uložíš.
          </Body>

          {error ? <Notice tone="danger" title="Účet sa nepodarilo vytvoriť" body={error} /> : null}

          <Input
            label="Meno"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Alex Kováč"
            autoCapitalize="words"
            autoComplete="name"
            error={fieldErrors.displayName}
            editable={!loading}
          />

          <Input
            label="E-mail"
            value={email}
            onChangeText={setEmail}
            placeholder="ty@example.com"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            error={fieldErrors.email}
            editable={!loading}
          />

          <Input
            label="Heslo"
            value={password}
            onChangeText={setPassword}
            placeholder="Aspoň 8 znakov"
            secureTextEntry
            autoComplete="new-password"
            error={fieldErrors.password}
            editable={!loading}
          />

          <Input
            label="Heslo znova"
            value={confirm}
            onChangeText={setConfirm}
            placeholder="Napíš ho ešte raz"
            secureTextEntry
            autoComplete="new-password"
            error={fieldErrors.confirm}
            editable={!loading}
            onSubmitEditing={submit}
          />

          <Button title="Vytvoriť účet" onPress={submit} loading={loading} />

          {/* Named and reachable before the account exists, not buried in
              settings afterwards — consent to something unread is not consent. */}
          <Caption style={styles.legal}>
            Vytvorením účtu súhlasíš s{' '}
            <Text style={styles.legalLink} onPress={() => router.push('/legal/terms')}>
              obchodnými podmienkami
            </Text>
            {' '}a berieš na vedomie{' '}
            <Text style={styles.legalLink} onPress={() => router.push('/legal/privacy')}>
              spracúvanie osobných údajov
            </Text>
            .
          </Caption>

        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  legal: { textAlign: 'center', marginTop: spacing.md, lineHeight: 18 },
  legalLink: { color: colors.accent, fontWeight: '700' },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  content: { padding: spacing.xl },
  intro: { marginBottom: spacing.xl },
});
