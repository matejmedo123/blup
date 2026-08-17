import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';

import { colors, emojiFor, radius, shadow, spacing, typography } from '@/theme';
import {
  estimateWalkingTime, formatCount, formatDistanceFromYou, formatEventDate, formatPrice,
} from '@/lib/format';
import type { EventFeedItem } from '@/types/models';
import { Badge } from './ui';

/**
 * The big event card — the visual centre of the app.
 * Used in the Home rails, Explore results and the swipe deck.
 */
export function EventCard({
  event, onPress, onSave, size = 'large', showScore,
}: {
  event: EventFeedItem;
  onPress?: () => void;
  onSave?: () => void;
  size?: 'large' | 'compact';
  showScore?: boolean;
}) {
  const distance = formatDistanceFromYou(event.distance_m);
  const walk = estimateWalkingTime(event.distance_m);
  const isCompact = size === 'compact';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${event.title}, ${formatEventDate(event.start_at)}`}
      style={({ pressed }) => [
        styles.card,
        isCompact && styles.cardCompact,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.cover, isCompact && styles.coverCompact]}>
        {event.cover_image_url ? (
          <Image
            source={{ uri: event.cover_image_url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.coverFallback]}>
            <Text style={styles.coverEmoji}>{emojiFor(event.category)}</Text>
          </View>
        )}

        <View style={styles.coverTop}>
          <View style={styles.pricePill}>
            <Text style={styles.pricePillText}>
              {event.is_free ? 'Free' : formatPrice(event.price_cents, event.currency)}
            </Text>
          </View>

          {onSave ? (
            <Pressable
              onPress={onSave}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={event.is_saved ? 'Remove from saved' : 'Save event'}
              style={styles.saveButton}
            >
              <Text style={styles.saveIcon}>{event.is_saved ? '★' : '☆'}</Text>
            </Pressable>
          ) : null}
        </View>

        {showScore && event.score !== null ? (
          <View style={styles.scorePill}>
            <Text style={styles.scorePillText}>{Math.round(Number(event.score) * 100)}% match</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <Text style={styles.date}>{formatEventDate(event.start_at)}</Text>
        <Text style={styles.title} numberOfLines={2}>
          {event.title}
        </Text>

        <View style={styles.metaRow}>
          {event.venue_name ? (
            <Text style={styles.meta} numberOfLines={1}>
              {event.venue_name}
            </Text>
          ) : null}
          {distance ? <Text style={styles.metaAccent}>{distance}</Text> : null}
          {walk && !isCompact ? <Text style={styles.meta}>{walk}</Text> : null}
        </View>

        {event.explanation ? (
          <Text style={styles.explanation} numberOfLines={2}>
            ✨ {event.explanation}
          </Text>
        ) : null}

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            {formatCount(event.attendee_count)} going
          </Text>

          {event.friends_going > 0 ? (
            <Badge
              tone="accent"
              label={`${event.friends_going} you follow`}
            />
          ) : null}

          {event.organization_verified ? <Badge tone="success" label="✓ Verified" /> : null}

          {event.capacity && event.attendee_count >= event.capacity ? (
            <Badge tone="danger" label="Full" />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  cardCompact: { width: 260 },
  pressed: { opacity: 0.9, transform: [{ scale: 0.995 }] },

  cover: { height: 190, backgroundColor: colors.surfaceElevated },
  coverCompact: { height: 140 },
  coverFallback: { alignItems: 'center', justifyContent: 'center' },
  coverEmoji: { fontSize: 52 },

  coverTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: spacing.md,
  },
  pricePill: {
    backgroundColor: colors.overlay,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  pricePillText: { ...typography.micro, color: colors.text },
  saveButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveIcon: { fontSize: 18, color: colors.text },

  scorePill: {
    position: 'absolute',
    bottom: spacing.md,
    left: spacing.md,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  scorePillText: { ...typography.micro, color: colors.accent },

  body: { padding: spacing.lg, gap: spacing.xs },
  date: { ...typography.micro, color: colors.accent, textTransform: 'uppercase' },
  title: { ...typography.heading, color: colors.text },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  meta: { ...typography.caption, color: colors.textSecondary },
  metaAccent: { ...typography.caption, color: colors.text },

  explanation: {
    ...typography.caption,
    color: colors.textSecondary,
    fontStyle: 'italic',
    marginTop: spacing.xs,
  },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  },
  footerText: { ...typography.caption, color: colors.textSecondary },
});
