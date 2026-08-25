import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, familyFor, categoryFamilies, radius, spacing, typography } from '@/theme';
import { formatCount, formatDistance, formatEventDate, formatPrice } from '@/lib/format';
import { reasonLabel } from '@/lib/labels';
import { CARD_MAX } from '@/hooks/useLayout';
import type { EventFeedItem } from '@/types/models';
import { GradientCover } from './GradientCover';
import { AvatarStack } from './ui';

/**
 * The large event card from the handoff.
 *
 * Hero 168 with the category gradient and hatching; two glass badges top-left
 * (category, tag); a 38px blup star top-right; the mono photo placeholder
 * bottom-left. Body: title 18/900, then "Dnes · 21:00 · 0.8 km · Nivy Tower",
 * then three 26px avatars with "{n} ide" in accent and the price badge.
 */
export function EventCard({
  event, onPress, onSave, size = 'large', showScore, attendees = [],
}: {
  event: EventFeedItem;
  onPress?: () => void;
  onSave?: () => void;
  size?: 'large' | 'compact';
  showScore?: boolean;
  attendees?: { id: string; avatar_url?: string | null; name?: string | null }[];
}) {
  const isCompact = size === 'compact';
  const family = categoryFamilies[familyFor(event.category)];
  const distance = formatDistance(event.distance_m);

  const meta = [formatEventDate(event.start_at), distance, event.venue_name]
    .filter(Boolean)
    .join(' · ');

  const tag = event.score_breakdown?.facts?.is_boosted
    ? 'Sponzorované'
    : event.friends_going > 2
      ? 'Kruhy'
      : event.attendee_count > 150
        ? 'Trending'
        : event.is_free
          ? 'Zdarma'
          : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${event.title}, ${formatEventDate(event.start_at)}`}
      style={({ pressed }) => [styles.card, isCompact && styles.cardCompact, pressed && styles.pressed]}
    >
      <GradientCover
        uri={event.cover_image_url}
        category={event.category}
        height={isCompact ? 96 : 168}
        whole={!isCompact}
        showPlaceholderLabel={!isCompact}
      >
        <View style={styles.coverTop}>
          <View style={styles.coverBadges}>
            <GlassBadge label={family.label} />
            {tag && !isCompact ? <GlassBadge label={tag} /> : null}
          </View>

          {onSave && !isCompact ? (
            <Pressable
              onPress={onSave}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={event.is_saved ? 'Odobrať blup' : 'Blupnúť'}
              style={[styles.blupButton, event.is_saved && styles.blupButtonActive]}
            >
              <Text style={styles.blupIcon}>{event.is_saved ? '★' : '☆'}</Text>
            </Pressable>
          ) : null}
        </View>

        {showScore && event.score !== null ? (
          <View style={styles.scorePill}>
            <Text style={styles.scoreText}>{Math.round(Number(event.score) * 100)} % ZHODA</Text>
          </View>
        ) : null}
      </GradientCover>

      <View style={[styles.body, isCompact && styles.bodyCompact]}>
        <Text
          style={[styles.title, isCompact && styles.titleCompact]}
          numberOfLines={2}
        >
          {event.title}
        </Text>
        <Text style={[styles.meta, isCompact && styles.metaCompact]} numberOfLines={1}>
          {meta}
        </Text>

        {/* The LLM's sentence when there is one, the ranker's own reason when
            there is not — the same score produced both, so they cannot
            contradict each other, and the card is never silent about why it
            is here. */}
        {event.explanation || reasonLabel(event.score_breakdown?.reason) ? (
          <Text style={styles.reason} numberOfLines={2}>
            {event.explanation ?? reasonLabel(event.score_breakdown?.reason)}
          </Text>
        ) : null}

        {!isCompact ? (
          <View style={styles.footer}>
            <View style={styles.footerLeft}>
              {attendees.length > 0 ? <AvatarStack people={attendees} size={26} max={3} /> : null}
              <Text style={styles.going}>
                {event.friends_going > 0
                  ? `${event.friends_going} z tvojich kruhov ide`
                  : `${formatCount(event.attendee_count)} ide`}
              </Text>
            </View>

            <View style={styles.price}>
              <Text style={styles.priceLabel}>
                {event.is_free ? 'Zdarma' : formatPrice(event.price_cents, event.currency)}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** The glass badge that sits on a photo. */
function GlassBadge({ label }: { label: string }) {
  return (
    <View style={styles.glass}>
      <Text style={styles.glassLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    // A card is a card, not a banner. Past this width the cover turns into a
    // letterbox strip and the two lines of text under it float in white space —
    // which is what a full-width card on a desktop monitor actually looks like.
    width: '100%',
    maxWidth: CARD_MAX,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.cardLarge,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardCompact: { width: 190, maxWidth: 190, borderRadius: radius.card },
  pressed: { borderColor: colors.borderAccent },

  coverTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: spacing.md,
  },
  coverBadges: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', flex: 1 },

  glass: {
    backgroundColor: colors.overlay,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 11,
  },
  glassLabel: { ...typography.micro, color: colors.text },

  blupButton: {
    width: 38,
    height: 38,
    borderRadius: radius.block,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  blupButtonActive: { backgroundColor: colors.accent },
  blupIcon: { fontSize: 18, color: '#FFFFFF' },

  scorePill: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
    backgroundColor: colors.overlay,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  scoreText: { ...typography.monoSm, color: '#FFFFFF' },

  body: { padding: spacing.lg, gap: spacing.sm },
  bodyCompact: { padding: spacing.md, gap: 4 },
  title: { ...typography.cardTitle, color: colors.text },
  titleCompact: { ...typography.rowTitleSm },
  meta: { ...typography.metaSm, color: colors.textTertiary },
  metaCompact: { fontSize: 11 },
  reason: { ...typography.metaSm, color: colors.cyan },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
    gap: spacing.md,
  },
  footerLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  going: { ...typography.metaSm, color: colors.accentText, flexShrink: 1 },

  price: {
    backgroundColor: colors.surfaceElevated2,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 11,
  },
  priceLabel: { ...typography.micro, color: colors.text },
});
