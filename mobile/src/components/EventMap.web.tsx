import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, emojiFor, radius, spacing, typography } from '@/theme';
import { formatDistanceFromYou, formatEventDate } from '@/lib/format';
import type { Coordinates, EventFeedItem } from '@/types/models';

/**
 * Web stand-in for the native map.
 *
 * react-native-maps has no web implementation, so on web the same events are
 * shown as a positional list instead. Metro picks this file automatically when
 * bundling for web; the native EventMap.tsx is untouched. The web build exists
 * so the app can be tried without a phone — so this states plainly that the real
 * map lives in the mobile build rather than faking one.
 */
export function EventMap({
  events,
  userLocation,
  selectedId,
  onSelect,
  style,
}: {
  events: EventFeedItem[];
  userLocation?: Coordinates | null;
  selectedId?: string | null;
  onSelect?: (event: EventFeedItem) => void;
  onRegionChange?: unknown;
  radiusM?: number;
  style?: object;
  interactive?: boolean;
}) {
  return (
    <View style={[styles.container, style]}>
      <View style={styles.banner}>
        <Text style={styles.bannerText}>
          🗺️ The interactive map runs in the iOS/Android build — here are the same
          events{userLocation ? ', with live distances' : ''}.
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {events.length === 0 ? (
          <Text style={styles.empty}>No events in this area yet</Text>
        ) : (
          events.map((event) => (
            <Pressable
              key={event.id}
              onPress={() => onSelect?.(event)}
              style={[styles.row, selectedId === event.id && styles.rowSelected]}
            >
              <View style={[styles.pin, !event.is_free && styles.pinPaid]}>
                <Text style={styles.pinEmoji}>{emojiFor(event.category)}</Text>
              </View>

              <View style={styles.rowBody}>
                <Text style={styles.title} numberOfLines={1}>
                  {event.title}
                </Text>
                <Text style={styles.meta}>
                  {formatEventDate(event.start_at)}
                  {event.venue_name ? ` · ${event.venue_name}` : ''}
                </Text>
                <Text style={styles.coords}>
                  {formatDistanceFromYou(event.distance_m) ??
                    `${event.latitude.toFixed(4)}, ${event.longitude.toFixed(4)}`}
                </Text>
              </View>
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.surface, overflow: 'hidden' },
  banner: { padding: spacing.md, backgroundColor: colors.accentSoft },
  bannerText: { ...typography.caption, color: colors.accent, textAlign: 'center' },

  list: { padding: spacing.md, gap: spacing.sm },
  empty: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    padding: spacing.xl,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceElevated,
  },
  rowSelected: { backgroundColor: colors.accentSoft },
  rowBody: { flex: 1 },

  pin: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.mapMarker,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinPaid: { backgroundColor: colors.mapMarkerPaid },
  pinEmoji: { fontSize: 17 },

  title: { ...typography.bodyStrong, color: colors.text },
  meta: { ...typography.caption, color: colors.textSecondary },
  coords: { ...typography.caption, color: colors.textTertiary },
});
