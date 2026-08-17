import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

/**
 * Push notifications via Expo's push service.
 *
 * Registration stores the device token in `push_tokens`; the push-dispatch Edge
 * Function reads unsent rows from `notifications` and delivers them. Nothing is
 * sent from the device itself.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export type PushRegistrationResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'SIMULATOR' | 'PERMISSION_DENIED' | 'NO_PROJECT_ID' | 'ERROR'; message: string };

export async function registerForPushNotifications(): Promise<PushRegistrationResult> {
  if (!Device.isDevice) {
    return {
      ok: false,
      reason: 'SIMULATOR',
      message: 'Push notifications only work on a physical device.',
    };
  }

  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'BLUP',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#5B8CFF',
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;

    if (status !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync();
      status = requested.status;
    }

    if (status !== 'granted') {
      return {
        ok: false,
        reason: 'PERMISSION_DENIED',
        message: 'Notifications are off. Turn them on in Settings to get event reminders.',
      };
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

    if (!projectId) {
      return {
        ok: false,
        reason: 'NO_PROJECT_ID',
        message:
          'No EAS project id found. Run `eas init` (or set EAS_PROJECT_ID) so Expo can issue a push token.',
      };
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

    const { data: userData } = await supabase.auth.getUser();
    if (userData?.user?.id) {
      const { error } = await supabase.from('push_tokens').upsert(
        {
          user_id: userData.user.id,
          token,
          platform: Platform.OS === 'ios' ? 'ios' : 'android',
          device_name: Device.deviceName ?? null,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'token' },
      );
      if (error) throw error;
    }

    return { ok: true, token };
  } catch (error) {
    return {
      ok: false,
      reason: 'ERROR',
      message: error instanceof Error ? error.message : 'Could not register for notifications.',
    };
  }
}

export async function unregisterPushToken(token: string): Promise<void> {
  await supabase.from('push_tokens').delete().eq('token', token);
}

/** Local reminder so an event nudge works even without the push service. */
export async function scheduleEventReminder(event: {
  id: string;
  title: string;
  start_at: string;
  venue_name?: string | null;
}): Promise<string | null> {
  const startsAt = new Date(event.start_at).getTime();
  const remindAt = startsAt - 2 * 60 * 60 * 1000; // two hours before

  if (remindAt <= Date.now()) return null;

  return Notifications.scheduleNotificationAsync({
    content: {
      title: `${event.title} starts soon`,
      body: event.venue_name ? `Doors at ${event.venue_name}` : 'Starting in 2 hours',
      data: { event_id: event.id, type: 'event_reminder' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(remindAt),
    },
  });
}

export async function cancelReminder(notificationId: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(notificationId);
}

export async function setBadgeCount(count: number): Promise<void> {
  await Notifications.setBadgeCountAsync(count);
}
