import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { Body, Button, Screen } from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

/**
 * What a guest sees on the parts of the app that are inherently personal.
 *
 * Not an error and not a wall: the events, the map and the search are all open
 * without an account. This screen only stands where there is genuinely nothing
 * to show a stranger — their own messages, their own profile — and it says what
 * an account would give them rather than just refusing.
 */
export function SignInInvite({
  glyph = '👋',
  title,
  body,
  perks,
}: {
  glyph?: string;
  title: string;
  body: string;
  perks?: string[];
}) {
  return (
    <Screen scroll>
      <View style={styles.wrap}>
        <Text style={styles.glyph}>{glyph}</Text>
        <Text style={styles.title}>{title}</Text>
        <Body muted style={styles.body}>{body}</Body>

        {perks?.length ? (
          <View style={styles.perks}>
            {perks.map((perk) => (
              <View key={perk} style={styles.perk}>
                <Text style={styles.tick}>✓</Text>
                <Body style={styles.perkText}>{perk}</Body>
              </View>
            ))}
          </View>
        ) : null}

        <Button title="Vytvoriť účet" onPress={() => router.push('/(auth)/sign-up')} />
        <Button title="Už mám účet" variant="secondary" onPress={() => router.push('/(auth)/sign-in')} />

        <Body muted style={styles.footnote}>
          Prezerať eventy môžeš aj bez účtu — stačí sa vrátiť na Domov.
        </Body>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.xxxl },
  glyph: { fontSize: 48 },
  title: { ...typography.title, color: colors.text, textAlign: 'center' },
  body: { textAlign: 'center', maxWidth: 420 },
  perks: { gap: spacing.sm, marginVertical: spacing.lg, alignSelf: 'stretch', maxWidth: 420 },
  perk: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  tick: { ...typography.bodyStrong, color: colors.success },
  perkText: { flex: 1 },
  footnote: { textAlign: 'center', marginTop: spacing.lg },
});
