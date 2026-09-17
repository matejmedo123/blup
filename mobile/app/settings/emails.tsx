import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getEmailPreferences, setEmailPreferences } from '@/api/mailing';
import { getMyWaitlist, leaveWaitlist } from '@/api/waitlist';
import { messageFor } from '@/lib/errors';
import { formatEventDateLong } from '@/lib/format';
import {
  Body, Button, Caption, Divider, LoadingState, Notice, Screen, SectionHeader, Switch,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * What BLUP is allowed to put in your inbox.
 *
 * Deliberately one screen for both halves — the switch and the list of things
 * you asked to be told about — because "why am I getting this?" is one question
 * and answering it in two places is answering it in neither.
 *
 * The switch talks to the address, not the account: somebody who clicked
 * "nechcem takéto e-maily" in a mail on their phone, with no session, has to
 * see that here and be able to take it back.
 */
export default function EmailSettingsScreen() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prefs = useQuery({ queryKey: ['email', 'prefs'], queryFn: getEmailPreferences });
  const waiting = useQuery({ queryKey: ['waitlist', 'mine'], queryFn: getMyWaitlist });

  if (prefs.isLoading) return <Screen><LoadingState /></Screen>;

  const digest = prefs.data?.digest_opt_in ?? false;

  const toggle = async (next: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await setEmailPreferences(next);
      await queryClient.invalidateQueries({ queryKey: ['email', 'prefs'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const stopWaiting = async (ticketTypeId: string) => {
    setError(null);
    setBusy(true);
    try {
      await leaveWaitlist(ticketTypeId);
      await waiting.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>E-maily</Text>
      <Body muted style={styles.intro}>
        Posielame na {prefs.data?.email ?? 'tvoju adresu'}.
      </Body>

      {error ? <Notice tone="danger" title="Nedá sa" body={error} /> : null}

      {prefs.data?.undeliverable ? (
        <Notice
          tone="danger"
          title="Na túto adresu sa nedá písať"
          body="Posledný e-mail sa vrátil ako nedoručiteľný, tak sme prestali skúšať. Zmeň si adresu v profile — inak ti neprídu ani vstupenky."
        />
      ) : null}

      <SectionHeader title="Čo ti chodí" />

      <View style={styles.card}>
        <Switch
          value={digest}
          onValueChange={(next) => { if (!busy) void toggle(next); }}
          label="Týždenný výber"
          description="Raz týždenne pár vecí, ktoré sa dejú pri tebe. Nič iné to nie je."
        />
      </View>

      <Caption style={styles.note}>
        Vstupenky, potvrdenia a vrátenie peňazí ti prídu vždy — to nie je reklama,
        to je to, čo si si kúpil. Vypnúť sa nedajú.
      </Caption>

      {prefs.data?.unsubscribed ? (
        <Notice
          tone="warning"
          title="Odhlásil si sa zo všetkého"
          body="Klikol si v niektorom e-maili na „Nechcem takéto e-maily“. Organizátori ti odvtedy nepíšu. Zapnutím týždenného výberu vyššie to vezmeš späť."
        />
      ) : null}

      <Divider />

      <SectionHeader title="Čakáš na" />
      {waiting.isLoading ? <LoadingState /> : null}

      {(waiting.data ?? []).length === 0 ? (
        <Caption style={styles.note}>
          Keď je niečo vypredané, môžeš si pýtať upozornenie. Napíšeme ti, len keď sa
          naozaj uvoľní — a len toľkým ľuďom, koľko je vstupeniek.
        </Caption>
      ) : (
        (waiting.data ?? []).map((entry) => (
          <View key={entry.ticket_type_id} style={styles.card}>
            <View style={styles.rowHead}>
              <View style={styles.flex}>
                <Text style={styles.rowName}>{entry.event_title}</Text>
                <Caption>
                  {entry.ticket_type} · {formatEventDateLong(entry.start_at)}
                </Caption>
                <Caption>
                  {entry.available > 0
                    ? `Práve je voľných ${entry.available}`
                    : `Čaká ${entry.waiting}${entry.waiting === 1 ? ' človek' : entry.waiting < 5 ? ' ľudia' : ' ľudí'}`}
                  {entry.notified_at ? ' · už sme ti písali' : ''}
                </Caption>
              </View>
              <Button
                title="Zrušiť"
                variant="ghost"
                compact
                disabled={busy}
                onPress={() => stopWaiting(entry.ticket_type_id)}
              />
            </View>
          </View>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  flex: { flex: 1, minWidth: 0 },
  note: { marginTop: spacing.sm, marginBottom: spacing.md },

  card: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowName: { ...typography.bodyStrong, color: colors.text },
});
