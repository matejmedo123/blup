import type { BlupEvent } from '@/types/models';

/**
 * Calendar and directions in a browser.
 *
 * There is no OS calendar to write to, so "add to calendar" produces an .ics
 * file — which every calendar application on every platform imports. That is
 * the honest web equivalent, not a disabled button.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** iCalendar wants UTC basic format: 20260912T210000Z. */
function icsDate(iso: string): string {
  const d = new Date(iso);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Escapes the characters iCalendar treats as syntax. */
const esc = (text: string) =>
  text.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

export async function addEventToCalendar(event: {
  title: string;
  start_at: string;
  end_at?: string | null;
  address?: string | null;
  venue_name?: string | null;
  description?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const end = event.end_at
      ? new Date(event.end_at)
      : new Date(new Date(event.start_at).getTime() + 3 * 60 * 60 * 1000);

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Blup//SK',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${crypto.randomUUID()}@blup.app`,
      `DTSTAMP:${icsDate(new Date().toISOString())}`,
      `DTSTART:${icsDate(event.start_at)}`,
      `DTEND:${icsDate(end.toISOString())}`,
      `SUMMARY:${esc(event.title)}`,
      event.description ? `DESCRIPTION:${esc(event.description)}` : null,
      event.venue_name || event.address
        ? `LOCATION:${esc([event.venue_name, event.address].filter(Boolean).join(', '))}`
        : null,
      'BEGIN:VALARM',
      'TRIGGER:-PT2H',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(event.title)}`,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean);

    // CRLF is not a stylistic choice here — RFC 5545 requires it, and at least
    // one popular calendar client silently rejects the file without it.
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `${event.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60) || 'event'}.ics`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    return { ok: true, message: 'Stiahli sme ti .ics — otvor ho a event sa pridá do kalendára.' };
  } catch {
    return { ok: false, message: 'Kalendárový súbor sa nepodarilo vytvoriť.' };
  }
}

export async function openDirections(
  event: Pick<BlupEvent, 'latitude' | 'longitude' | 'title' | 'address'>,
) {
  const query = event.latitude && event.longitude
    ? `${event.latitude},${event.longitude}`
    : event.address ?? event.title;

  window.open(
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
    '_blank',
    'noopener,noreferrer',
  );
}
