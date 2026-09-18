import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import {
  getEmailHealth, getEmailQueueStats, sendTestEmail, type EmailHealthDay,
} from '@/api/emailOps';
import { messageFor } from '@/lib/errors';
import { useToast } from '@/components/Toast';
import {
  Body, Button, Caption, ErrorState, LoadingState, Notice, Panel, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Chodia e-maily?
 *
 * An e-mail that is accepted by the provider and then filed as spam looks
 * exactly like one that arrived: status 'sent', and nothing else to see. That is
 * why this page exists and why it leads with the failure rate rather than the
 * total — the total only ever goes up.
 *
 * The test button deliberately goes through the queue rather than calling the
 * provider directly. A test that bypasses the worker passes on a deployment
 * where the worker is not running, which is precisely the deployment you are
 * testing.
 */
export default function AdminEmailsScreen() {
  const toast = useToast();
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['admin', 'email-queue'],
    queryFn: getEmailQueueStats,
    refetchInterval: 30_000,
  });

  const health = useQuery({ queryKey: ['admin', 'email-health'], queryFn: getEmailHealth });

  const sendTest = async () => {
    setError(null);
    setSending(true);
    try {
      await sendTestEmail();
      // Not "odoslané". It is in the queue; the worker decides the rest.
      toast.show('Test je vo fronte — o chvíľu ho uvidíš tu nižšie');
      await queue.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSending(false);
    }
  };

  if (queue.isLoading || health.isLoading) {
    return <Screen><LoadingState label="Čítam frontu…" /></Screen>;
  }
  if (queue.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(queue.error)} onRetry={() => void queue.refetch()} />
      </Screen>
    );
  }

  const q = queue.data!;
  const h = health.data;
  const stuck = q.waiting > 0 && q.sent_last_hour === 0;

  return (
    <Screen scroll>
      <Text style={styles.title}>E-maily</Text>
      <Body muted style={styles.intro}>
        E-mail, ktorý skončí v spame, vyzerá tu rovnako ako ten, čo dorazil.
        Preto sú hore zlyhania a odrazy, nie počet odoslaných.
      </Body>

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      {/* The one condition worth interrupting for: mail is piling up and
          nothing has gone out for an hour. That is a cron that is not running,
          not a slow queue. */}
      {stuck ? (
        <Notice
          tone="danger"
          title="Fronta stojí"
          body={`${q.waiting} e-mailov čaká a za poslednú hodinu neodišiel ani jeden. Skontroluj cron „blup-emails“ — volá funkciu ticket-email.`}
        />
      ) : null}

      {h && h.failure_rate_pct >= 5 ? (
        <Notice
          tone="warning"
          title={`Zlyháva ${h.failure_rate_pct} % e-mailov`}
          body="Nad pár percent to už nie je o jednej adrese, ale o doméne alebo poskytovateľovi. Skontroluj DNS (npm run check:dns) a dôvody nižšie."
        />
      ) : null}

      <SectionHeader title="Teraz" />
      <View style={styles.tiles}>
        <Tile label="Čaká vo fronte" value={q.waiting} />
        <Tile label="Odišlo za hodinu" value={q.sent_last_hour} note={`strop ${q.budget_per_hour}`} />
        <Tile label="Za 24 hodín" value={q.sent_today} />
        <Tile label="Vzdalo to" value={q.dead} tone={q.dead > 0 ? 'bad' : undefined} />
      </View>

      <SectionHeader title="Adresy" />
      <View style={styles.tiles}>
        <Tile label="Kontaktov" value={q.contacts} />
        <Tile label="Odhlásených" value={q.unsubscribed} />
        <Tile
          label="Nedoručiteľných"
          value={q.undeliverable}
          tone={q.undeliverable > 0 ? 'warn' : undefined}
        />
      </View>
      <Caption style={styles.note}>
        Nedoručiteľné adresy zapisuje webhook od poskytovateľa (funkcia
        email-events). Keď je toto číslo stále nula a posielaš tisíce e-mailov,
        webhook nie je nastavený — a tvrdé odrazy ti potichu kazia reputáciu
        domény.
      </Caption>

      {h ? (
        <>
          <SectionHeader title="Posledných 7 dní" />
          <Panel>
            <View style={styles.headRow}>
              <Text style={[styles.cell, styles.cellHead, styles.cellDay]}>Deň</Text>
              <Text style={[styles.cell, styles.cellHead]}>Odišlo</Text>
              <Text style={[styles.cell, styles.cellHead]}>Zlyhalo</Text>
              <Text style={[styles.cell, styles.cellHead]}>Preskočené</Text>
            </View>
            {h.days.length === 0 ? (
              <Caption>Za týždeň sa neposlal ani jeden e-mail.</Caption>
            ) : (
              h.days.map((day: EmailHealthDay) => (
                <View key={day.day} style={styles.row}>
                  <Text style={[styles.cell, styles.cellDay]}>{day.day}</Text>
                  <Text style={styles.cell}>{day.sent}</Text>
                  <Text style={[styles.cell, day.failed > 0 && styles.bad]}>{day.failed}</Text>
                  <Text style={styles.cell}>{day.skipped}</Text>
                </View>
              ))
            )}
          </Panel>

          {h.errors.length > 0 ? (
            <>
              <SectionHeader title="Na čom to padá" />
              {h.errors.map((row) => (
                <View key={row.reason} style={styles.errorRow}>
                  <Text style={styles.errorCount}>{row.n}×</Text>
                  <Text style={styles.errorReason}>{row.reason}</Text>
                </View>
              ))}
            </>
          ) : null}

          <View style={styles.tiles}>
            <Tile label="Odrazilo sa" value={h.bounced} tone={h.bounced > 0 ? 'warn' : undefined} />
            <Tile
              label="Sťažností"
              value={h.complained}
              tone={h.complained > 0 ? 'bad' : undefined}
            />
          </View>
        </>
      ) : null}

      <SectionHeader title="Skúška" />
      <Body muted style={styles.note}>
        Pošle e-mail na tvoju vlastnú adresu — tou istou cestou ako vstupenky.
        Ak nepríde, problém je vo fronte alebo u poskytovateľa. Ak príde do
        spamu, problém je v DNS.
      </Body>
      <Button
        title={sending ? 'Zaraďujem…' : 'Poslať testovací e-mail'}
        onPress={sendTest}
        loading={sending}
        variant="secondary"
        large
      />
    </Screen>
  );
}

function Tile({
  label, value, note, tone,
}: {
  label: string;
  value: number;
  note?: string;
  tone?: 'warn' | 'bad';
}) {
  return (
    <View style={styles.tile}>
      <Text style={[
        styles.tileValue,
        tone === 'warn' && styles.warn,
        tone === 'bad' && styles.bad,
      ]}>
        {value.toLocaleString('sk-SK')}
      </Text>
      <Text style={styles.tileLabel}>{label}</Text>
      {note ? <Text style={styles.tileNote}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.screenTitle, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.md },
  note: { marginTop: spacing.xs, marginBottom: spacing.md },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexGrow: 1,
    flexBasis: 120,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tileValue: { ...typography.title, color: colors.text },
  tileLabel: { ...typography.caption, color: colors.textTertiary },
  tileNote: { ...typography.caption, color: colors.textQuaternary },

  headRow: { flexDirection: 'row', paddingBottom: spacing.xs },
  row: { flexDirection: 'row', paddingVertical: 4 },
  cell: { ...typography.caption, color: colors.textSecondary, flex: 1, textAlign: 'right' },
  cellHead: { color: colors.textQuaternary },
  cellDay: { flex: 1.6, textAlign: 'left' },

  errorRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xs },
  errorCount: { ...typography.caption, color: colors.orange, minWidth: 40 },
  errorReason: { ...typography.caption, color: colors.textTertiary, flex: 1 },

  warn: { color: colors.orange },
  bad: { color: colors.danger },
});
