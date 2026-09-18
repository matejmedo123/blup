import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getMyEvents } from '@/api/events';
import { getMyOrganizations, getOrganizationEvents } from '@/api/organizations';
import { getMyBoosts, type EventBoost } from '@/api/boost';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatMoney } from '@/lib/format';
import {
  Body, Caption, EmptyState, ErrorState, LoadingState, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Reklama — prehľad.
 *
 * The per-event screen answers "how is this event doing". This answers "what am
 * I paying for right now", which is the question somebody with four events open
 * actually has, and it is also the door: the whole ad system used to be
 * reachable only by opening a bottom sheet from one event's row, which is why
 * it was reported as missing.
 */
export default function AdsOverviewScreen() {
  const organizations = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: getMyOrganizations,
  });

  const organization = organizations.data?.[0];

  const orgEvents = useQuery({
    queryKey: ['organizer', 'events', organization?.id],
    queryFn: () => getOrganizationEvents(organization!.id),
    enabled: Boolean(organization?.id),
  });

  const myEvents = useQuery({ queryKey: ['events', 'mine'], queryFn: getMyEvents });

  // One list, no duplicates: an event created under a personal organization
  // appears in both queries.
  const events = React.useMemo(() => {
    const seen = new Map<string, { id: string; title: string; start_at: string; end_at: string | null }>();
    for (const event of [...(orgEvents.data ?? []), ...(myEvents.data ?? [])]) {
      seen.set(event.id, event as never);
    }
    return [...seen.values()]
      .filter((event) => new Date(event.end_at ?? event.start_at) > new Date())
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
  }, [orgEvents.data, myEvents.data]);

  const boosts = useQuery({
    queryKey: ['boosts', 'mine', events.map((e) => e.id).join(',')],
    queryFn: () => getMyBoosts(events.map((e) => e.id)),
    enabled: events.length > 0,
  });

  const runningFor = (eventId: string): EventBoost[] => (boosts.data ?? []).filter(
    (boost) => boost.event_id === eventId
      && boost.payment_status === 'succeeded'
      && new Date(boost.ends_at) > new Date(),
  );

  if (organizations.isLoading || myEvents.isLoading) {
    return <Screen><LoadingState /></Screen>;
  }
  if (myEvents.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(myEvents.error)} onRetry={() => void myEvents.refetch()} />
      </Screen>
    );
  }

  const live = (boosts.data ?? []).filter(
    (b) => b.payment_status === 'succeeded' && new Date(b.ends_at) > new Date(),
  );
  const spend = live.reduce((sum, b) => sum + b.amount_cents, 0);

  return (
    <Screen scroll>
      <Text style={styles.title}>Reklama</Text>
      <Body muted style={styles.intro}>
        Vyber event a nastav si rozpočet, okruh a záujmy ľudí, ktorým sa má
        ukázať. Cenu počíta BLUP — ty určuješ, koľko doň dáš.
      </Body>

      {live.length > 0 ? (
        <View style={styles.summary}>
          <View style={styles.flex}>
            <Text style={styles.summaryValue}>{live.length}</Text>
            <Text style={styles.summaryLabel}>
              {live.length === 1 ? 'kampaň beží' : 'kampaní beží'}
            </Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.summaryValue}>{formatMoney(spend, 'EUR')}</Text>
            <Text style={styles.summaryLabel}>zaplatené za ne</Text>
          </View>
        </View>
      ) : null}

      <SectionHeader title="Tvoje eventy" />

      {events.length === 0 ? (
        <EmptyState
          emoji="◆"
          title="Zatiaľ niet čo propagovať"
          body="Reklama potrebuje event, ktorý ešte nebol. Vytvor prvý a vráť sa sem."
          actionLabel="Vytvoriť event"
          onAction={() => router.push('/organizer/create')}
        />
      ) : (
        events.map((event) => {
          const running = runningFor(event.id);
          return (
            <Pressable
              key={event.id}
              style={styles.row}
              onPress={() => router.push(`/organizer/ads/${event.id}`)}
            >
              <View style={styles.flex}>
                <Text style={styles.rowTitle} numberOfLines={1}>{event.title}</Text>
                <Text style={styles.rowMeta}>{formatEventDate(event.start_at)}</Text>
                {running.length > 0 ? (
                  <Text style={styles.rowRunning}>
                    {running.length === 1 ? 'Beží kampaň' : `Bežia ${running.length} kampane`}
                    {running.some((b) => b.paused_at) ? ' · jedna pozastavená' : ''}
                  </Text>
                ) : (
                  <Text style={styles.rowIdle}>Bez reklamy</Text>
                )}
              </View>
              <Text style={styles.rowArrow}>→</Text>
            </Pressable>
          );
        })
      )}

      <Caption style={styles.note}>
        Reklama na BLUPe je vždy označená ako sponzorovaná a nikdy sa neukáže
        človeku, ktorému event nesedí — na to je prah relevancie, ktorý sa
        peniazmi prekročiť nedá.
      </Caption>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  title: { ...typography.screenTitle, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.md },
  note: { marginTop: spacing.lg },

  summary: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  summaryValue: { ...typography.title, color: colors.text },
  summaryLabel: { ...typography.caption, color: colors.textTertiary },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  rowTitle: { ...typography.rowTitle, color: colors.text },
  rowMeta: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },
  rowRunning: { ...typography.metaSm, color: colors.green, marginTop: 3 },
  rowIdle: { ...typography.metaSm, color: colors.textQuaternary, marginTop: 3 },
  rowArrow: { ...typography.rowTitle, color: colors.accent },
});
