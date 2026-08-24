import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';

import { getOrganization, getOrganizationEvents } from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { EventCard } from '@/components/EventCard';
import {
  Badge, Body, Caption, EmptyState, ErrorState, LoadingState, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * An organizer's public page.
 *
 * The event page used to send anyone tapping "Organizuje …" to the founder's
 * personal profile, which is exactly what somebody trading as "Event Bros" does
 * not want. This is where that tap goes now: the organization's own name, logo
 * and events, with no mention of whose account created it.
 */
export default function OrganizationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const organization = useQuery({
    queryKey: ['organization', id],
    queryFn: () => getOrganization(id!),
    enabled: Boolean(id),
  });

  const events = useQuery({
    queryKey: ['organization', id, 'events', 'public'],
    queryFn: () => getOrganizationEvents(id!),
    enabled: Boolean(id),
  });

  if (organization.isLoading) return <Screen><LoadingState /></Screen>;
  if (organization.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(organization.error)} onRetry={() => void organization.refetch()} />
      </Screen>
    );
  }

  const org = organization.data;
  if (!org) {
    return (
      <Screen>
        <EmptyState emoji="🔍" title="Nenašli sme to" body="Tento organizátor tu už nie je." />
      </Screen>
    );
  }

  // Only what a visitor may see: published, not cancelled, soonest first.
  const upcoming = (events.data ?? [])
    .filter((event) => event.status === 'published' && new Date(event.start_at) >= new Date())
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());

  const past = (events.data ?? [])
    .filter((event) => event.status === 'published' && new Date(event.start_at) < new Date());

  return (
    <Screen scroll>
      <View style={styles.head}>
        {org.logo_url ? (
          <Image source={{ uri: org.logo_url }} style={styles.logo} contentFit="cover" />
        ) : (
          <View style={[styles.logo, styles.logoEmpty]}>
            <Text style={styles.logoGlyph}>{org.name.slice(0, 1).toUpperCase()}</Text>
          </View>
        )}

        <View style={styles.flex}>
          <Text style={styles.name}>{org.name}</Text>
          {org.verification_status === 'verified' ? (
            <Badge label="Overený organizátor" tone="success" />
          ) : null}
        </View>
      </View>

      {org.description ? <Body muted style={styles.about}>{org.description}</Body> : null}

      <SectionHeader title={`Čo chystá · ${upcoming.length}`} />
      {upcoming.length === 0 ? (
        <Body muted>Zatiaľ nič nové. Pozri sa sem o pár dní.</Body>
      ) : (
        upcoming.map((event) => (
          <EventCard
            key={event.id}
            event={event as never}
            onPress={() => router.push(`/event/${event.id}`)}
          />
        ))
      )}

      {past.length > 0 ? (
        <>
          <SectionHeader title={`Už bolo · ${past.length}`} />
          {past.slice(0, 10).map((event) => (
            <EventCard
              key={event.id}
              event={event as never}
              onPress={() => router.push(`/event/${event.id}`)}
            />
          ))}
        </>
      ) : null}

      <Caption style={styles.footnote}>
        Vstupenky predáva overený subjekt, ktorého údaje nájdeš na samotnej vstupenke.
      </Caption>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  flex: { flex: 1, minWidth: 0, gap: spacing.xs, alignItems: 'flex-start' },
  logo: { width: 76, height: 76, borderRadius: radius.lg, backgroundColor: colors.surfaceElevated },
  logoEmpty: { alignItems: 'center', justifyContent: 'center' },
  logoGlyph: { ...typography.title, color: colors.textSecondary },
  name: { ...typography.title, color: colors.text },
  about: { marginBottom: spacing.md },
  footnote: { marginTop: spacing.xl },
});
