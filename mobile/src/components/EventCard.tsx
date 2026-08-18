import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, labelFor, radius, shadow, spacing, typography } from '@/theme';
import { formatCount, formatDistance, formatEventDate, formatPrice } from '@/lib/format';
import type { EventFeedItem } from '@/types/models';
import { GradientCover } from './GradientCover';
import { AvatarStack, Chip, PricePill } from './ui';

/**
 * The event card — the visual centre of BLUP.
 *
 * Cover, category chips over it, a save star, then a compact meta line
 * ("Dnes · 21:00 · 0.8 km · Nivy Tower") and a footer that pairs social proof
 * with the price.
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
  const distance = formatDistance(event.distance_m);

  const meta = [
    formatEventDate(event.start_at),
    distance,
    event.venue_name,
  ].filter(Boolean).join(' · ');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${event.title}, ${formatEventDate(event.start_at)}`}
      style={({ pressed }) => [styles.card, isCompact && styles.cardCompact, pressed && styles.pressed]}
    >
      <GradientCover
        uri={event.cover_image_url}
        seed={event.id}
        height={isCompact ? 150 : 210}
        showPlaceholderLabel={!isCompact}
      >
        <View style={styles.coverTop}>
          <View style={styles.coverChips}>
            <Chip label={labelFor(event.category)} onCover />
            {event.friends_going > 0 ? <Chip label="Frčí" onCover /> : null}
          </View>

          {onSave ? (
            <Pressable
              onPress={onSave}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={event.is_saved ? 'Odstrániť z uložených' : 'Uložiť event'}
              style={styles.saveButton}
            >
              <Text style={[styles.saveIcon, event.is_saved && styles.saveIconActive]}>
                {event.is_saved ? '★' : '☆'}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {showScore && event.score !== null ? (
          <View style={styles.scorePill}>
            <Text style={styles.scoreText}>{Math.round(Number(event.score) * 100)} % zhoda</Text>
          </View>
        ) : null}
      </GradientCover>

      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>{event.title}</Text>
        <Text style={styles.meta} numberOfLines={1}>{meta}</Text>

        {event.explanation ? (
          <Text style={styles.explanation} numberOfLines={2}>✨ {event.explanation}</Text>
        ) : null}

        <View style={styles.footer}>
          <View style={styles.footerLeft}>
            {attendees.length > 0 ? <AvatarStack people={attendees} size={28} max={3} /> : null}
            <Text style={styles.going}>
              {event.friends_going > 0
                ? `${event.friends_going} z tvojich kruhov ide`
                : `${formatCount(event.attendee_count)} ide`}
            </Text>
          </View>

          <PricePill
            label={event.is_free ? 'Zdarma' : formatPrice(event.price_cents, event.currency)}
          />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  cardCompact: { width: 270 },
  pressed: { opacity: 0.92, transform: [{ scale: 0.995 }] },

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
  coverChips: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', flex: 1 },
  saveButton: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.chipOnCover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveIcon: { fontSize: 19, color: '#FFFFFF' },
  saveIconActive: { color: colors.warning },

  scorePill: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
    backgroundColor: colors.chipOnCover,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  scoreText: { ...typography.mono, color: '#FFFFFF' },

  body: { padding: spacing.lg, gap: spacing.xs },
  title: { ...typography.heading, color: colors.text },
  meta: { ...typography.caption, color: colors.textSecondary },
  explanation: {
    ...typography.caption,
    color: colors.textSecondary,
    fontStyle: 'italic',
    marginTop: spacing.xs,
  },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    gap: spacing.md,
  },
  footerLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  going: { ...typography.captionStrong, color: colors.accentText },
});
