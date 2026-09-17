import React, { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { claimInvite } from '@/api/invites';
import { useAuth } from '@/auth/AuthProvider';
import { messageFor } from '@/lib/errors';
import { forgetInvite, rememberInvite } from '@/lib/pendingInvite';
import { Body, Button, Caption, Notice, Screen } from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

/**
 * Where an invite link lands.
 *
 * Somebody arriving here usually has no account yet, which is the whole point,
 * so the screen cannot just call claim_invite() and fail. It keeps the code,
 * sends them to sign up, and applies it on the way back — and says plainly what
 * the code is worth, because "you have been invited!" with no explanation is
 * what every referral scam looks like.
 */
export default function InviteLandingScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { isGuest } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Kept before anything else happens: from here the road to an account goes
  // through a mail client and back, and nothing in a route param survives that.
  useEffect(() => {
    if (code) void rememberInvite(String(code));
  }, [code]);

  const apply = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await claimInvite(String(code ?? ''));
      await forgetInvite();
      setDone(result.inviter ?? 'kamarát');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>Máš pozvánku</Text>
      <Body muted style={styles.intro}>
        Niekto ti poslal svoj kód na BLUP. Nájdeš tu, čo sa deje okolo teba —
        koncerty, párty, výstavy, aj veci, o ktorých by si sa inak nedozvedel.
      </Body>

      <Text style={styles.code}>{String(code ?? '').toUpperCase()}</Text>

      {error ? <Notice tone="danger" title="Kód sa nedá uplatniť" body={error} /> : null}

      {done ? (
        <Notice
          tone="success"
          title={`Priviedol ťa ${done}`}
          body="Keď prídeš na svoj prvý event, dostanete body obaja. Nič viac za to nie je — ani ty, ani on nikomu nič neplatíte."
          actionLabel="Pozrieť, čo sa deje"
          onAction={() => router.replace('/')}
        />
      ) : isGuest ? (
        <>
          <Button
            title="Spraviť si účet"
            onPress={() => router.push('/(auth)/sign-up')}
          />
          <Caption style={styles.note}>
            Kód si pamätáme — uplatní sa hneď, ako sa prihlásiš. Platí 14 dní od
            založenia účtu.
          </Caption>
        </>
      ) : (
        <>
          <Button title="Uplatniť kód" onPress={apply} loading={busy} />
          <Caption style={styles.note}>
            Body prídu, až keď naozaj na niečom budeš — nie za samotnú registráciu.
          </Caption>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  code: {
    ...typography.title,
    color: colors.accent,
    letterSpacing: 4,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  note: { marginTop: spacing.sm },
});
