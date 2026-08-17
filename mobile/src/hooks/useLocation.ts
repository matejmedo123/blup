import { useCallback, useEffect, useState } from 'react';
import * as Location from 'expo-location';
import { AppState, Linking, Platform } from 'react-native';

import { updateMyLocation } from '@/api/profiles';
import type { Coordinates } from '@/types/models';

export type LocationStatus =
  | 'idle'
  | 'requesting'
  | 'granted'
  | 'denied'
  | 'services_disabled'
  | 'error';

interface LocationState {
  coords: Coordinates | null;
  city: string | null;
  status: LocationStatus;
  error: string | null;
  accuracy: number | null;
  updatedAt: Date | null;
}

/**
 * Real device GPS. There is no fake default position anywhere in the app: if
 * permission is denied the UI says so and offers the settings shortcut, and
 * distance-based features degrade explicitly instead of inventing a location.
 */
export function useLocation(options: { persist?: boolean; watch?: boolean } = {}) {
  const { persist = true, watch = false } = options;

  const [state, setState] = useState<LocationState>({
    coords: null,
    city: null,
    status: 'idle',
    error: null,
    accuracy: null,
    updatedAt: null,
  });

  const resolve = useCallback(
    async (position: Location.LocationObject) => {
      const coords: Coordinates = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };

      setState((previous) => ({
        ...previous,
        coords,
        status: 'granted',
        accuracy: position.coords.accuracy ?? null,
        updatedAt: new Date(),
        error: null,
      }));

      // Reverse geocoding is a nice-to-have; never let it break positioning.
      let city: string | null = null;
      try {
        const [place] = await Location.reverseGeocodeAsync(coords);
        city = place?.city ?? place?.subregion ?? place?.region ?? null;
        if (city) setState((previous) => ({ ...previous, city }));
      } catch {
        /* ignore */
      }

      if (persist) {
        try {
          await updateMyLocation({ ...coords, city });
        } catch (error) {
          if (__DEV__) console.warn('Could not save location to the profile:', error);
        }
      }
    },
    [persist],
  );

  const request = useCallback(async () => {
    setState((previous) => ({ ...previous, status: 'requesting', error: null }));

    try {
      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        setState((previous) => ({
          ...previous,
          status: 'services_disabled',
          error: 'Location services are turned off on this device.',
        }));
        return null;
      }

      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        setState((previous) => ({
          ...previous,
          status: 'denied',
          error: 'BLUP needs your location to show what is happening around you.',
        }));
        return null;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      await resolve(position);
      return { latitude: position.coords.latitude, longitude: position.coords.longitude };
    } catch (error) {
      setState((previous) => ({
        ...previous,
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not determine your location.',
      }));
      return null;
    }
  }, [resolve]);

  // If permission was already granted, pick the position up silently on mount.
  useEffect(() => {
    let cancelled = false;

    Location.getForegroundPermissionsAsync().then(async ({ status }) => {
      if (cancelled || status !== 'granted') return;
      try {
        const position = await Location.getLastKnownPositionAsync();
        if (position && !cancelled) {
          await resolve(position);
        } else {
          await request();
        }
      } catch {
        /* handled by request() */
      }
    });

    return () => {
      cancelled = true;
    };
  }, [request, resolve]);

  // Re-check when the user comes back from the settings app.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && (state.status === 'denied' || state.status === 'services_disabled')) {
        void request();
      }
    });
    return () => subscription.remove();
  }, [request, state.status]);

  // Continuous updates for the map screen.
  useEffect(() => {
    if (!watch || state.status !== 'granted') return;

    let subscription: Location.LocationSubscription | null = null;

    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, distanceInterval: 60, timeInterval: 20000 },
      (position) => {
        setState((previous) => ({
          ...previous,
          coords: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          },
          accuracy: position.coords.accuracy ?? null,
          updatedAt: new Date(),
        }));
      },
    ).then((sub) => {
      subscription = sub;
    });

    return () => subscription?.remove();
  }, [watch, state.status]);

  const openSettings = useCallback(() => {
    if (Platform.OS === 'ios') {
      void Linking.openURL('app-settings:');
    } else {
      void Linking.openSettings();
    }
  }, []);

  return { ...state, request, openSettings, isReady: state.status === 'granted' && Boolean(state.coords) };
}
