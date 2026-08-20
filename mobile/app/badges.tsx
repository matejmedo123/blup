import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { getBadgeProgress, getGamification, levelProgress, levelTitle, xpToNextLevel } from '@/api/gamification';
import { SignInInvite } from '@/components/SignInInvite';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import { Body, ErrorState, LoadingState, Mono, Screen, SectionHeader } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { BadgeProgress } from '@/types/models';

const METRIC_LABEL: Record<string, string> = {
  events_created: 'vytvorených eventov',
  events_attended: 'eventov, na ktoré si šiel',
  check_ins: 'check-inov',
  blups_saved: 'uložených blupov',
  streak_days: 'dní v sérii',
  level: 'level',
  xp: 'XP',
};

/** Odznaky — the whole catalogue, with what you have and what is still ahead. */
export default function BadgesScreen() {
  const { isGuest } = useAuth();

  const state = useQuery({
    queryKey: ['gamification', 'me'],
    queryFn: () => getGamification(),
    enabled: !isGuest,
  });
  const badges = useQuery({
    queryKey: ['badges', 'progress'],
    queryFn: getBadgeProgress,
    enabled: !isGuest,
  });

  // Without this a guest is told their session expired, which is a confusing
  // way to say "you never had one".
  if (isGuest) {
    return (
      <SignInInvite
        glyph="🏅"
        title="Odznaky sa zbierajú na účet"
        body="Séria dní, levely a odznaky rátajú, kde si naozaj bol. Bez účtu ich niet kam zapísať."
      />
    );
  }

  if (state.isLoading || badges.isLoading) return <Screen><LoadingState /></Screen>;

  if (state.isError || badges.isError) {
    return (
      <Screen>
        <ErrorState
          message={messageFor(state.error ?? badges.error)}
          onRetry={() => {
            void state.refetch();
            void badges.refetch();
          }}
        />
      </Screen>
    );
  }

  const earned = (badges.data ?? []).filter((badge) => badge.earned);
  const locked = (badges.data ?? []).filter((badge) => !badge.earned);
  const progress = levelProgress(state.data);

  return (
    <Screen scroll>
      {/* --- level card ----------------------------------------------------- */}
      <LinearGradient
        colors={['#1E3A8A', '#2B6BFF']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.levelCard}
      >
        <View style={styles.levelTop}>
          <View style={styles.flex}>
            <Mono style={styles.levelLabel}>LEVEL {state.data?.level ?? 1}</Mono>
            <Text style={styles.levelTitle}>{levelTitle(state.data?.level ?? 1)}</Text>
          </View>
          <View style={styles.xpPill}>
            <Text style={styles.xpValue}>{state.data?.xp ?? 0}</Text>
            <Mono style={styles.xpUnit}>XP</Mono>
          </View>
        </View>

        <View style={styles.track}>
          <View style={[styles.trackFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
        <Mono style={styles.levelHint}>
          ešte {xpToNextLevel(state.data)} XP do levelu {(state.data?.level ?? 1) + 1}
        </Mono>
      </LinearGradient>

      {/* --- what earns points ---------------------------------------------- */}
      <View style={styles.statRow}>
        <StatChip value={state.data?.events_created ?? 0} label="vytvoril" />
        <StatChip value={state.data?.events_attended ?? 0} label="bol si" />
        <StatChip value={state.data?.check_ins ?? 0} label="check-inov" />
        <StatChip value={state.data?.streak_days ?? 0} label="dní v rade" />
      </View>

      <SectionHeader title={`Získané (${earned.length})`} />
      {earned.length === 0 ? (
        <Body muted style={styles.empty}>
          Zatiaľ žiadne. Vytvor event, choď na niečo alebo sa daj naskenovať pri vstupe — odznaky
          prídu samé.
        </Body>
      ) : (
        <View style={styles.grid}>
          {earned.map((badge) => <BadgeTile key={badge.slug} badge={badge} />)}
        </View>
      )}

      <SectionHeader title={`Ešte ťa čakajú (${locked.length})`} />
      <View style={styles.grid}>
        {locked.map((badge) => <BadgeTile key={badge.slug} badge={badge} />)}
      </View>

      <Body muted style={styles.footnote}>
        XP dostávaš iba za veci, ktoré sa naozaj stali — zverejnený event, potvrdená účasť,
        naskenovaná vstupenka. Nedá sa to nakúpiť ani obísť.
      </Body>
    </Screen>
  );
}

function StatChip({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.statChip}>
      <Text style={styles.statValue}>{value}</Text>
      <Mono style={styles.statLabel}>{label}</Mono>
    </View>
  );
}

function BadgeTile({ badge }: { badge: BadgeProgress }) {
  const ratio = badge.threshold > 0 ? Math.min(1, badge.progress / badge.threshold) : 0;

  return (
    <View style={[styles.badge, badge.earned && styles.badgeEarned]}>
      <Text style={[styles.badgeEmoji, !badge.earned && styles.badgeEmojiLocked]}>
        {badge.emoji}
      </Text>
      <Text style={[styles.badgeName, badge.earned && styles.badgeNameEarned]} numberOfLines={2}>
        {badge.name}
      </Text>
      <Text style={styles.badgeDescription} numberOfLines={3}>{badge.description}</Text>

      {badge.earned ? (
        <Mono style={styles.badgeMeta}>
          {badge.awarded_at ? formatRelative(badge.awarded_at) : 'získané'}
        </Mono>
      ) : (
        <>
          <View style={styles.badgeTrack}>
            <View style={[styles.badgeTrackFill, { width: `${Math.round(ratio * 100)}%` }]} />
          </View>
          <Mono style={styles.badgeMeta}>
            {badge.progress}/{badge.threshold} {METRIC_LABEL[badge.metric] ?? badge.metric}
          </Mono>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },

  levelCard: { borderRadius: radius.xl, padding: spacing.lg, gap: spacing.md },
  levelTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  levelLabel: { color: 'rgba(255,255,255,0.75)' },
  levelTitle: { ...typography.heading, color: '#FFFFFF', marginTop: 2 },
  xpPill: {
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  xpValue: { ...typography.subheading, color: '#FFFFFF' },
  xpUnit: { color: 'rgba(255,255,255,0.75)' },

  track: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
  },
  trackFill: { height: 8, borderRadius: radius.pill, backgroundColor: '#FFFFFF' },
  levelHint: { color: 'rgba(255,255,255,0.8)' },

  statRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  statChip: {
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
  statLabel: { color: colors.textTertiary, fontSize: 10 },

  empty: { marginBottom: spacing.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  badge: {
    width: '47.5%',
    flexGrow: 1,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  badgeEarned: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  badgeEmoji: { fontSize: 30 },
  badgeEmojiLocked: { opacity: 0.4 },
  badgeName: { ...typography.bodyStrong, color: colors.textSecondary },
  badgeNameEarned: { color: colors.text },
  badgeDescription: { ...typography.caption, color: colors.textTertiary },
  badgeMeta: { color: colors.textTertiary, marginTop: 2 },
  badgeTrack: {
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceElevated,
    overflow: 'hidden',
    marginTop: spacing.xs,
  },
  badgeTrackFill: { height: 5, borderRadius: radius.pill, backgroundColor: colors.teal },

  footnote: { marginTop: spacing.xl, ...typography.caption },
});
