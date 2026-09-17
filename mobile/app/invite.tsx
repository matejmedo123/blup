import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { claimInvite, getMyInviteCode, getMyInvites, inviteLink } from '@/api/invites';
import { messageFor } from '@/lib/errors';
import { forgetInvite, takePendingInvite } from '@/lib/pendingInvite';
import { shareLink } from '@/lib/share';
import { formatRelative } from '@/lib/format';
import {
  Avatar, Badge, Body, Button, Caption, Input, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Pozvi kamarátov.
 *
 * The honest version of a referral screen, which means the number on it is not
 * "how many people clicked your link". It is how many of them actually came to
 * something — because that is the only number that earns anything, and showing
 * a bigger one next to it would be teaching people to spam the link.
 */
export default function InviteScreen() {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const invites = useQuery({ queryKey: ['invites', 'mine'], queryFn: getMyInvites });

  // Whatever they arrived with, if they arrived through somebody's link. The
  // field is prefilled rather than applied silently: a code that quietly ties
  // your account to a stranger's is the version of this that people hate.
  const pending = useQuery({ queryKey: ['invites', 'pending'], queryFn: takePendingInvite });

  // The code is allocated the first time somebody opens this screen, so an
  // account that never invites anybody never takes a code out of the namespace.
  const code = useQuery({
    queryKey: ['invites', 'code'],
    queryFn: getMyInviteCode,
    enabled: invites.isSuccess && !invites.data?.code,
  });

  const myCode = invites.data?.code ?? code.data ?? null;
  const link = myCode ? inviteLink(myCode) : null;

  if (invites.isLoading) return <Screen><LoadingState /></Screen>;

  /**
   * The phone's share sheet where there is one, the clipboard where there is
   * not. shareLink knows which platform it is on; this screen must not, or the
   * web gets a button that appears to work and does nothing.
   */
  const share = async () => {
    if (!link) return;
    setError(null);
    try {
      const result = await shareLink(link, 'Poď na Blup — nájdeš tam, čo sa deje okolo teba.');
      if (result.copied) setCopied(true);
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const data = invites.data;
  const arrivedWith = typed ?? pending.data ?? '';

  const useCode = async () => {
    setError(null);
    setBusy(true);
    try {
      await claimInvite(arrivedWith);
      await forgetInvite();
      setTyped('');
      await invites.refetch();
      await pending.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>Pozvi kamarátov</Text>
      <Body muted style={styles.intro}>
        Na event sa nechodí samý. Pošli im svoj kód — keď si niekto cezeň spraví
        účet a naozaj niekam príde, dostanete body obaja.
      </Body>

      {error ? <Notice tone="danger" title="Nedá sa" body={error} /> : null}

      <Pressable onPress={share} style={styles.codeBox} accessibilityRole="button"
                 accessibilityLabel={`Skopírovať kód ${myCode ?? ''}`}>
        <Caption>Tvoj kód</Caption>
        <Text style={styles.code}>{myCode ?? '…'}</Text>
        <Caption>{copied ? 'Skopírované ✓' : 'Klepni a skopíruj odkaz'}</Caption>
      </Pressable>

      <Button title="Poslať pozvánku" onPress={share} disabled={!link} />

      <View style={styles.tiles}>
        <Tile label="Pozvaných" value={data?.invited ?? 0} />
        <Tile label="Prišli" value={data?.arrived ?? 0} />
        <Tile label="Bodov za každého" value={data?.xp_each ?? 0} />
      </View>

      <Caption style={styles.rules}>
        Body prídu, až keď pozvaný človek potvrdí e-mail a kúpi si vstupenku alebo
        na niečom naozaj bude — nie za samotnú registráciu. Za mesiac sa počíta
        najviac desať ľudí. Nie je to naschvál: len to inak nerobia kamaráti, ale
        skripty.
      </Caption>

      {data?.came_from ? (
        <Notice
          tone="accent"
          title={`Priviedol ťa ${data.came_from}`}
          body="Keď prídeš na svoj prvý event, dostanete body obaja."
        />
      ) : (
        <>
          <SectionHeader title="Máš kód od kamaráta?" />
          <Input
            value={arrivedWith}
            onChangeText={(next) => setTyped(next.toUpperCase())}
            placeholder="NAPR. 7KQ2M4XB"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
          />
          <Button
            title="Uplatniť kód"
            variant="secondary"
            onPress={useCode}
            loading={busy}
            disabled={arrivedWith.trim().length < 4}
          />
          <Caption style={styles.rules}>
            Platí 14 dní od založenia účtu a dá sa použiť raz.
          </Caption>
        </>
      )}

      {(data?.people ?? []).length > 0 ? (
        <>
          <SectionHeader title={`Koho si pozval · ${data?.people.length}`} />
          {(data?.people ?? []).map((person, i) => (
            <View key={`${person.username ?? person.name ?? i}`} style={styles.row}>
              <Avatar url={person.avatar_url} name={person.name} size={40} />
              <View style={styles.flex}>
                <Text style={styles.rowName}>{person.name ?? person.username ?? 'Niekto'}</Text>
                <Caption>Pridal sa {formatRelative(person.joined_at)}</Caption>
              </View>
              {person.arrived
                ? <Badge label="PRIŠIEL" tone="success" />
                : <Badge label="ZATIAĽ NIE" tone="neutral" />}
            </View>
          ))}
        </>
      ) : null}
    </Screen>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{value}</Text>
      <Caption>{label}</Caption>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  flex: { flex: 1, minWidth: 0 },

  codeBox: {
    alignItems: 'center',
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.accentSoft,
    marginBottom: spacing.md,
    gap: 4,
  },
  code: {
    ...typography.title,
    color: colors.text,
    letterSpacing: 4,
    fontVariant: ['tabular-nums'],
  },

  tiles: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  tile: {
    flex: 1,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  tileValue: { ...typography.title, color: colors.text },

  rules: { marginTop: spacing.md, marginBottom: spacing.md },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  rowName: { ...typography.bodyStrong, color: colors.text },
});
