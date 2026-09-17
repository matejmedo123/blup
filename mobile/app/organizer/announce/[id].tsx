import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getEvent } from '@/api/events';
import {
  AUDIENCE_LABEL, AUDIENCE_NOTE, getCampaignAudience, getCampaignReport, getCampaigns,
  sendCampaign, type CampaignAudience,
} from '@/api/mailing';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import { useDialog } from '@/components/Dialog';
import {
  Body, Button, Caption, Chip, Input, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Napísať ľuďom, ktorí u teba boli.
 *
 * The most useful thing a ticketing platform can give an organizer, and the
 * easiest to turn into spam, so three things are deliberate.
 *
 * The audience is counted before anything is written, with the same query the
 * send uses — so the number the organizer commits to is the number that goes
 * out, not an estimate that turns out to have been optimistic.
 *
 * There is no draft. A half-written campaign sitting in a table is a thing that
 * gets sent by accident; the preview is the count, which can be asked for as
 * often as you like without creating anything.
 *
 * And the confirmation names the number out loud. "Poslať 1 240 ľuďom" is a
 * different decision from "Poslať", and it should be.
 */
const AUDIENCES: CampaignAudience[] = ['ticket_holders', 'attendees', 'past_attendees'];

export default function AnnounceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const dialog = useDialog();

  const [audience, setAudience] = useState<CampaignAudience>('ticket_holders');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  const organizationId = event.data?.organization_id ?? null;

  const people = useQuery({
    queryKey: ['campaign', organizationId, audience, id],
    queryFn: () => getCampaignAudience({
      organizationId: organizationId!,
      audience,
      // "Kto u teba niekedy bol" is about the organizer, not this event.
      eventId: audience === 'past_attendees' ? null : id,
    }),
    enabled: Boolean(organizationId),
  });

  const history = useQuery({
    queryKey: ['campaign', organizationId, 'history'],
    queryFn: () => getCampaigns(organizationId!),
    enabled: Boolean(organizationId),
  });

  if (event.isLoading) return <Screen><LoadingState /></Screen>;

  if (!organizationId) {
    return (
      <Screen>
        <Notice
          tone="warning"
          title="Event nepatrí organizácii"
          body="Rozposielať e-maily vie len overená organizácia — je to jej meno, ktoré je pod nimi podpísané."
          actionLabel="Späť"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const count = people.data?.length ?? 0;

  const send = async () => {
    setError(null);
    setNote(null);

    if (subject.trim().length < 3) { setError('Napíš predmet — je to jediné, čo väčšina ľudí uvidí.'); return; }
    if (body.trim().length < 20) { setError('Napíš aspoň pár viet. Kratšie to vyzerá ako omyl.'); return; }
    if (count === 0) { setError('Takto vybraných ľudí je nula — nie je komu písať.'); return; }

    const ok = await dialog.confirm({
      title: `Poslať ${count} ${count === 1 ? 'človeku' : count < 5 ? 'ľuďom' : 'ľuďom'}?`,
      body: 'E-mail odíde hneď a vziať späť sa nedá. Každý sa z takýchto e-mailov '
          + 'vie odhlásiť jedným klikom — a kto sa odhlási, tomu už nenapíšeš nikdy.',
      confirmLabel: 'Poslať',
    });
    if (!ok) return;

    setBusy(true);
    try {
      const campaign = await sendCampaign({
        organizationId,
        audience,
        subject: subject.trim(),
        body: body.trim(),
        eventId: audience === 'past_attendees' ? null : id,
      });

      setNote(`Odoslané ${campaign.recipients} ľuďom. Chodí to postupne, aby to neskončilo v spame.`);
      setSubject('');
      setBody('');
      await history.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>Napísať ľuďom</Text>
      <Body muted style={styles.intro}>
        {event.data?.title
          ? `Z eventu ${event.data.title}. Podpísané tvojím menom, posielané z BLUPu.`
          : 'Podpísané tvojím menom, posielané z BLUPu.'}
      </Body>

      {error ? <Notice tone="danger" title="Nedá sa" body={error} /> : null}
      {note ? <Notice tone="success" title="Odoslané" body={note} /> : null}

      <SectionHeader title="Komu" />
      <View style={styles.chips}>
        {AUDIENCES.map((option) => (
          <Chip
            key={option}
            label={AUDIENCE_LABEL[option]}
            selected={audience === option}
            onPress={() => setAudience(option)}
          />
        ))}
      </View>
      <Caption style={styles.note}>{AUDIENCE_NOTE[audience]}</Caption>

      <View style={styles.countBox}>
        {people.isLoading ? (
          <Caption>Počítam…</Caption>
        ) : (
          <>
            <Text style={styles.count}>{count}</Text>
            <Caption>
              {count === 0
                ? 'Takto vybraných ľudí zatiaľ nemáš.'
                : 'ľudí dostane tento e-mail. Bez tých, čo sa už odhlásili.'}
            </Caption>
          </>
        )}
      </View>

      <SectionHeader title="Čo im napíšeš" />
      <Input
        label="Predmet"
        value={subject}
        onChangeText={setSubject}
        placeholder="Napr. Začíname o hodinu neskôr"
        maxLength={120}
        editable={!busy}
      />
      <Input
        label="Text"
        value={body}
        onChangeText={setBody}
        placeholder="Napíš to tak, ako by si to povedal pri vstupe."
        multiline
        numberOfLines={8}
        maxLength={4000}
        style={styles.bodyInput}
        editable={!busy}
      />
      <Caption style={styles.note}>
        Bez formátovania a bez obrázkov — jednoduchý e-mail sa doručí a prečíta.
        Odkaz na event a odhlásenie doplníme sami.
      </Caption>

      <Button title={count > 0 ? `Poslať ${count} ľuďom` : 'Poslať'} onPress={send} loading={busy} />

      <Caption style={styles.note}>
        Tri rozposlania za deň. Nie je to technický limit — je to o tom, koľko im
        vieš napísať, kým to prestanú otvárať.
      </Caption>

      {(history.data ?? []).length > 0 ? (
        <>
          <SectionHeader title="Čo si už poslal" />
          {(history.data ?? []).map((campaign) => (
            <SentRow key={campaign.id} id={campaign.id} subject={campaign.subject}
                     recipients={campaign.recipients} at={campaign.created_at} />
          ))}
        </>
      ) : null}
    </Screen>
  );
}

/** One past rozposlanie, with what actually happened to it. */
function SentRow({
  id, subject, recipients, at,
}: { id: string; subject: string; recipients: number; at: string }) {
  const report = useQuery({
    queryKey: ['campaign', id, 'report'],
    queryFn: () => getCampaignReport(id),
  });

  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={styles.rowName} numberOfLines={1}>{subject}</Text>
        <Caption>
          {`${recipients} ľuďom · ${formatRelative(at)}`}
        </Caption>
        {report.data ? (
          <Caption>
            {`doručené ${report.data.sent}`}
            {report.data.pending > 0 ? ` · čaká ${report.data.pending}` : ''}
            {report.data.failed > 0 ? ` · neprešlo ${report.data.failed}` : ''}
            {report.data.unsubscribed > 0 ? ` · odhlásilo sa ${report.data.unsubscribed}` : ''}
          </Caption>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  flex: { flex: 1, minWidth: 0 },
  note: { marginTop: spacing.xs, marginBottom: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },

  countBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    marginBottom: spacing.md,
  },
  count: { ...typography.title, color: colors.text },

  bodyInput: { minHeight: 160, textAlignVertical: 'top' },

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
