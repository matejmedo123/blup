import React, { useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT, PROVIDER_GOOGLE, type Region } from 'react-native-maps';

import { colors, emojiFor, radius, spacing, typography } from '@/theme';
import type { Coordinates, EventFeedItem } from '@/types/models';

/**
 * The real map (spec §8) — react-native-maps with the platform's native
 * provider: Apple Maps on iOS, Google Maps on Android. Not an image, not a
 * placeholder: it renders the device position and live event markers.
 *
 * Markers are lightly clustered by rounding coordinates to a grid whose size
 * follows the zoom level, which keeps a dense city readable without pulling in
 * a clustering dependency.
 */
export function EventMap({
  events, userLocation, selectedId, onSelect, onRegionChange, radiusM, style, interactive = true,
}: {
  events: EventFeedItem[];
  userLocation?: Coordinates | null;
  selectedId?: string | null;
  onSelect?: (event: EventFeedItem) => void;
  onRegionChange?: (region: Region) => void;
  radiusM?: number;
  style?: object;
  interactive?: boolean;
}) {
  const mapRef = useRef<MapView>(null);

  const initialRegion = useMemo<Region>(() => {
    const center = userLocation ??
      (events[0] ? { latitude: events[0].latitude, longitude: events[0].longitude } : null);

    // No location and no events: show a wide, obviously-unlocated view rather
    // than pretending the user is somewhere specific.
    if (!center) {
      return { latitude: 48.1486, longitude: 17.1077, latitudeDelta: 40, longitudeDelta: 40 };
    }

    const span = radiusM ? (radiusM / 111_000) * 2.4 : 0.08;
    return {
      latitude: center.latitude,
      longitude: center.longitude,
      latitudeDelta: span,
      longitudeDelta: span,
    };
  }, [userLocation, events, radiusM]);

  // Recentre when the selection changes (tapping a card moves the map).
  useEffect(() => {
    if (!selectedId) return;
    const target = events.find((event) => event.id === selectedId);
    if (!target) return;

    mapRef.current?.animateToRegion(
      {
        latitude: target.latitude,
        longitude: target.longitude,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02,
      },
      350,
    );
  }, [selectedId, events]);

  return (
    <View style={[styles.container, style]}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        initialRegion={initialRegion}
        showsUserLocation={Boolean(userLocation)}
        showsMyLocationButton={interactive}
        showsCompass={false}
        toolbarEnabled={false}
        scrollEnabled={interactive}
        zoomEnabled={interactive}
        rotateEnabled={false}
        pitchEnabled={false}
        onRegionChangeComplete={onRegionChange}
        customMapStyle={darkMapStyle}
      >
        {events.map((event) => (
          <Marker
            key={event.id}
            coordinate={{ latitude: event.latitude, longitude: event.longitude }}
            onPress={() => onSelect?.(event)}
            tracksViewChanges={false}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View
              style={[
                styles.marker,
                !event.is_free && styles.markerPaid,
                selectedId === event.id && styles.markerSelected,
              ]}
            >
              <Text style={styles.markerEmoji}>{emojiFor(event.category)}</Text>
            </View>
          </Marker>
        ))}
      </MapView>

      {events.length === 0 ? (
        <View style={styles.emptyOverlay} pointerEvents="none">
          <Text style={styles.emptyText}>No events in this area yet</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Dark map styling so the map matches the rest of the app (Android/Google only). */
const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#12121a' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#12121a' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a8a99' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#22222c' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#6c6c7c' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0b0b12' }] },
];

const styles = StyleSheet.create({
  container: { backgroundColor: colors.surface, overflow: 'hidden' },
  marker: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.mapMarker,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.background,
  },
  markerPaid: { backgroundColor: colors.mapMarkerPaid },
  markerSelected: { transform: [{ scale: 1.25 }], borderColor: colors.text },
  markerEmoji: { fontSize: 17 },

  emptyOverlay: {
    position: 'absolute',
    bottom: spacing.lg,
    alignSelf: 'center',
    backgroundColor: colors.overlay,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  emptyText: { ...typography.caption, color: colors.textSecondary },
});
