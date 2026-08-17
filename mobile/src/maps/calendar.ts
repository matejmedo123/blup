import * as Calendar from 'expo-calendar';
import { Linking, Platform } from 'react-native';

import type { BlupEvent } from '@/types/models';

/**
 * Calendar + external maps integration (spec §25, §8).
 * Both write to the OS, so both ask for permission and report a real result.
 */

export async function addEventToCalendar(event: {
  title: string;
  start_at: string;
  end_at?: string | null;
  address?: string | null;
  venue_name?: string | null;
  description?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  const { status } = await Calendar.requestCalendarPermissionsAsync();

  if (status !== 'granted') {
    return { ok: false, message: 'Calendar access is off. Enable it in Settings to add events.' };
  }

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const target =
    calendars.find((calendar) => calendar.allowsModifications && calendar.isPrimary) ??
    calendars.find((calendar) => calendar.allowsModifications);

  if (!target) {
    return { ok: false, message: 'No writable calendar was found on this device.' };
  }

  const start = new Date(event.start_at);
  const end = event.end_at ? new Date(event.end_at) : new Date(start.getTime() + 3 * 3600 * 1000);

  await Calendar.createEventAsync(target.id, {
    title: event.title,
    startDate: start,
    endDate: end,
    location: event.address ?? event.venue_name ?? undefined,
    notes: event.description ?? undefined,
    alarms: [{ relativeOffset: -120 }],
  });

  return { ok: true, message: 'Added to your calendar.' };
}

/** Opens the platform maps app with directions to the event. */
export async function openDirections(event: Pick<BlupEvent, 'latitude' | 'longitude' | 'title' | 'address'>) {
  const label = encodeURIComponent(event.title);
  const coords = `${event.latitude},${event.longitude}`;

  const url =
    Platform.OS === 'ios'
      ? `maps://app?daddr=${coords}&q=${label}`
      : `geo:${coords}?q=${coords}(${label})`;

  const fallback = `https://www.google.com/maps/dir/?api=1&destination=${coords}`;

  try {
    const supported = await Linking.canOpenURL(url);
    await Linking.openURL(supported ? url : fallback);
  } catch {
    await Linking.openURL(fallback);
  }
}
