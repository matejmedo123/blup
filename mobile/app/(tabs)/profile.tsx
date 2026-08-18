import React from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { getFollowCounts, getInterestsFor } from '@/api/profiles';
import { getMyEvents, getSavedEvents, getAttendingEvents, toFeedItem } from '@/api/events';
import { getMyTickets } from '@/api/tickets';
import { getMyOrganizations } from '@/api/organizations';
import { getPremiumStatus } from '@/api/premium';
import { getGamification, levelProgress, levelTitle, xpToNextLevel } from '@/api/gamification';
import { env } from '@/lib/env';
import { formatCount } from '@/lib/format';
import { EventCard } from '@/components/EventCard';
import {
  Avatar, Badge, Body, Button, Chip, LoadingState, Mono, Screen, SectionHeader,
} from '@/components/ui';
import { colors, heroGradient, radius, spacing, typography } from '@/theme';

export default function ProfileScreen() {
  const { profile, isAdmin, signOut, refreshProfile, loadingProfile } = useAuth();

  const counts = useQuery({
    queryKey: ['profile', 'counts', profile?.id],
    queryFn: () => getFollowCounts(profile!.id),
    enabled: Boolean(profile?.id),
  });

  const interests = useQuery({
    queryKey: ['profile', 'interests', profile?.id],
    queryFn: () => getInterestsFor(profile!.id),
    enabled: Boolean(profile?.id),
  });

  const myEvents = useQuery({ queryKey: ['events', 'mine'], queryFn: getMyEvents });
  const saved = useQuery({ queryKey: ['events', 'saved'], queryFn: getSavedEvents });
  const attending = useQuery({ queryKey: ['events', 'attending'], queryFn: getAttendingEvents });
  const tickets = useQuery({ queryKey: ['tickets', 'mine'], queryFn: getMyTickets });
  const organizations = useQuery({ queryKey: ['organizations', 'mine'], queryFn: getMyOrganizations });
  const premium = useQuery({ queryKey: ['premium', 'status'], queryFn: getPremiumStatus });
  const game = useQuery({ queryKey: ['gamification', 'me'], queryFn: () => getGamification() });

  if (loadingProfile && !profile) {
    return <Screen><LoadingState /></Screen>;
  }

  const validTickets = (tickets.data ?? []).filter((ticket) => ticket.status === 'valid');
  const createdCount = myEvents.data?.length ?? 0;
  const attendingCount = attending.data?.length ?? 0;

  return (
    <Screen
      scroll
      contentStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => {
            void refreshProfile();
            void counts.refetch();
            void myEvents.refetch();
            void saved.refetch();
            void attending.refetch();
            void tickets.refetch();
          }}
          tintColor={colors.accent}
        />
      }
    >
      {/* --- header band ---------------------------------------------------- */}
      <LinearGradient colors={[...heroGradient]} style={styles.hero}>
        <View style={styles.heroTop}>
          <Mono accent>◎ moj profil</Mono>
          <Pressable onPress={() => router.push('/settings')} hitSlop={10}>
            <Text style={styles.gear}>⚙</Text>
          </Pressable>
        </View>

        <Avatar url={profile?.avatar_url} name={profile?.display_name} size={92} ring />

        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {profile?.display_name ?? 'Tvoj profil'}
          </Text>
          {premium.data?.is_premium ? <Badge tone="accent" label="PREMIUM" /> : null}
        </View>
        <Mono style={styles.handle}>@{profile?.username ?? '—'}</Mono>

        {profile?.bio ? <Body style={styles.bio}>{profile.bio}</Body> : null}

        <View style={styles.stats}>
          <StatTile value={formatCount(createdCount)} label="blupov" />
          <StatTile value={formatCount(counts.data?.followers ?? 0)} label="sledujú ma" />
          <StatTile value={formatCount(counts.data?.following ?? 0)} label="sledujem" />
        </View>

        <View style={styles.actions}>
          <Button
            title="Upraviť profil"
            variant="secondary"
            compact
            onPress={() => router.push('/settings/profile')}
            style={styles.flex}
          />
          <Button
            title="Nastavenia"
            variant="ghost"
            compact
            onPress={() => router.push('/settings')}
            style={styles.flex}
          />
        </View>
      </LinearGradient>

      {/* --- level ---------------------------------------------------------- */}
      <View style={styles.section}>
        <SectionHeader title="Tvoj level" action="Odznaky" onAction={() => router.push('/badges')} />

        <Pressable
          onPress={() => router.push('/badges')}
          style={({ pressed }) => [styles.levelCard, pressed && styles.pressed]}
        >
          <View style={styles.levelTop}>
            <View style={styles.levelBadge}>
              <Text style={styles.levelNumber}>{game.data?.level ?? 1}</Text>
            </View>

            <View style={styles.flex}>
              <Text style={styles.levelTitle}>{levelTitle(game.data?.level ?? 1)}</Text>
              <Mono style={styles.levelMeta}>
                {game.data?.xp ?? 0} XP · ešte {xpToNextLevel(game.data)} do ďalšieho levelu
              </Mono>
            </View>

            {(game.data?.streak_days ?? 0) > 1 ? (
              <View style={styles.streak}>
                <Text style={styles.streakEmoji}>🔥</Text>
                <Mono style={styles.streakValue}>{game.data?.streak_days}</Mono>
              </View>
            ) : null}
          </View>

          <View style={styles.track}>
            <View
              style={[styles.trackFill, { width: `${Math.round(levelProgress(game.data) * 100)}%` }]}
            />
          </View>

          {(game.data?.badges ?? []).length > 0 ? (
            <View style={styles.badgeRow}>
              {(game.data?.badges ?? []).slice(0, 6).map((badge) => (
                <View key={badge.slug} style={styles.badgeChip}>
                  <Text style={styles.badgeEmoji}>{badge.emoji}</Text>
                </View>
              ))}
              {(game.data?.badges ?? []).length > 6 ? (
                <Mono style={styles.badgeMore}>+{(game.data?.badges ?? []).length - 6}</Mono>
              ) : null}
            </View>
          ) : (
            <Mono style={styles.levelMeta}>
              odznaky sa odomykajú za reálne veci — event, účasť, check-in
            </Mono>
          )}
        </Pressable>
      </View>

      {/* --- interests ------------------------------------------------------ */}
      <View style={styles.section}>
        <SectionHeader
          title="Záujmy"
          action="Upraviť"
          onAction={() => router.push('/settings/interests')}
        />
        {(interests.data ?? []).length > 0 ? (
          <View style={styles.chips}>
            {(interests.data ?? []).map((interest) => (
              <Chip key={interest.id} label={`${interest.emoji ?? ''} ${interest.name}`.trim()} />
            ))}
          </View>
        ) : (
          <Button
            title="Vyber si záujmy"
            variant="secondary"
            onPress={() => router.push('/settings/interests')}
          />
        )}
      </View>

      {/* --- quick links ---------------------------------------------------- */}
      <View style={styles.section}>
        <SectionHeader title="Tvoj BLUP" />
        <View style={styles.tiles}>
          <Tile
            glyph="◫"
            label="Vstupenky"
            detail={validTickets.length > 0 ? `${validTickets.length} platných` : 'Zatiaľ žiadne'}
            onPress={() => router.push('/tickets')}
          />
          <Tile
            glyph="☆"
            label="Uložené"
            detail={`${saved.data?.length ?? 0} blupov`}
            onPress={() => router.push('/settings/saved')}
          />
          <Tile
            glyph="◷"
            label="Idem na"
            detail={`${attendingCount} eventov`}
            onPress={() => router.push('/settings/attending')}
          />
          <Tile
            glyph="✦"
            label={premium.data?.is_premium ? 'Premium' : 'BLUP Premium'}
            detail={premium.data?.is_premium ? (premium.data.status ?? 'aktívne') : 'Vylepši si to'}
            highlight={!premium.data?.is_premium}
            onPress={() => router.push('/premium')}
          />
          <Tile
            glyph="◉"
            label={organizations.data?.length ? 'Organizátor' : 'Staň sa organizátorom'}
            detail={
              organizations.data?.length
                ? `${organizations.data.length} organizácií`
                : 'Predávaj vstupenky'
            }
            onPress={() => router.push(organizations.data?.length ? '/organizer' : '/organizer/new')}
          />
          <Tile
            glyph="🏅"
            label="Odznaky"
            detail={`${(game.data?.badges ?? []).length} získaných`}
            onPress={() => router.push('/badges')}
          />
          <Tile
            glyph="✦"
            label="Aktivita"
            detail="notifikácie"
            onPress={() => router.push('/activity')}
          />
          {isAdmin ? (
            <Tile glyph="⚑" label="Admin" detail="Moderácia" onPress={() => router.push('/admin')} />
          ) : null}
          {env.debugAi ? (
            <Tile
              glyph="✧"
              label="AI debug"
              detail="Prečo toto?"
              onPress={() => router.push('/debug/ai')}
            />
          ) : null}
        </View>
      </View>

      {/* --- my events ------------------------------------------------------ */}
      <View style={styles.section}>
        <SectionHeader title="Tvoje blupy" />
        {createdCount === 0 ? (
          <View style={styles.emptyCard}>
            <Body muted style={styles.emptyText}>
              Zatiaľ si nič nevytvoril. Tvoj prvý BLUP sa objaví tu.
            </Body>
            <Button title="Vytvoriť BLUP" onPress={() => router.push('/(tabs)/create')} />
          </View>
        ) : (
          (myEvents.data ?? []).slice(0, 5).map((event) => (
            <View key={event.id} style={styles.eventItem}>
              <EventCard event={toFeedItem(event)} onPress={() => router.push(`/event/${event.id}`)} />
            </View>
          ))
        )}
      </View>

      <Button title="Odhlásiť sa" variant="ghost" onPress={() => void signOut()} />
    </Screen>
  );
}

/** Read-only counter tile — the numbers come straight from the database. */
function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statValue}>{value}</Text>
      <Mono style={styles.statLabel}>{label}</Mono>
    </View>
  );
}

function Tile({
  glyph, label, detail, onPress, highlight,
}: {
  glyph: string;
  label: string;
  detail?: string;
  onPress: () => void;
  highlight?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.tile,
        highlight && styles.tileHighlight,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.tileIcon, highlight && styles.tileIconHighlight]}>
        <Text style={[styles.tileGlyph, highlight && styles.tileGlyphHighlight]}>{glyph}</Text>
      </View>
      <Text style={styles.tileLabel} numberOfLines={2}>{label}</Text>
      {detail ? <Mono style={styles.tileDetail} numberOfLines={1}>{detail}</Mono> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: 0, paddingBottom: spacing.xxxl },
  flex: { flex: 1 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },

  hero: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    borderBottomLeftRadius: radius.xxl,
    borderBottomRightRadius: radius.xxl,
    gap: spacing.sm,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    marginBottom: spacing.lg,
  },
  gear: { fontSize: 20, color: colors.textSecondary },

  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  name: { ...typography.heading, color: colors.text, flexShrink: 1 },
  handle: { color: colors.textTertiary },
  bio: { textAlign: 'center', color: colors.textSecondary, marginTop: spacing.sm },

  stats: { flexDirection: 'row', gap: spacing.sm, alignSelf: 'stretch', marginTop: spacing.lg },
  statTile: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  },
  statValue: { ...typography.subheading, color: colors.text },
  statLabel: { color: colors.textTertiary },

  actions: { flexDirection: 'row', gap: spacing.sm, alignSelf: 'stretch', marginTop: spacing.md },

  section: { paddingHorizontal: spacing.lg, marginTop: spacing.xl },

  levelCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
  },
  levelTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  levelBadge: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  levelNumber: { ...typography.subheading, color: '#FFFFFF' },
  levelTitle: { ...typography.bodyStrong, color: colors.text },
  levelMeta: { color: colors.textTertiary, marginTop: 2 },
  streak: { alignItems: 'center' },
  streakEmoji: { fontSize: 18 },
  streakValue: { color: colors.textSecondary },

  track: {
    height: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceElevated,
    overflow: 'hidden',
  },
  trackFill: { height: 7, borderRadius: radius.pill, backgroundColor: colors.accent },

  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  badgeChip: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeEmoji: { fontSize: 17 },
  badgeMore: { color: colors.textTertiary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: {
    width: '47.5%',
    flexGrow: 1,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  tileHighlight: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  tileIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  tileIconHighlight: { backgroundColor: colors.accent },
  tileGlyph: { fontSize: 17, color: colors.textSecondary },
  tileGlyphHighlight: { color: '#FFFFFF' },
  tileLabel: { ...typography.bodyStrong, color: colors.text },
  tileDetail: { color: colors.textTertiary },

  emptyCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
  },
  emptyText: { textAlign: 'center' },
  eventItem: { marginBottom: spacing.lg },
});
