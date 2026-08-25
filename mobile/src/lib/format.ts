import { format, formatDistanceToNowStrict, isToday, isTomorrow, isThisWeek } from 'date-fns';
import { sk } from 'date-fns/locale';

/** Every date in the app is rendered in Slovak. */
const locale = { locale: sk };

/** Money is stored in minor units; never format a float. */
export function formatPrice(cents: number, currency = 'EUR'): string {
  if (cents === 0) return 'Zdarma';

  // A price badge drops the cents when there are none — "15 €" reads better on
  // a card than "15,00 €" — but the symbol still goes after the number, the way
  // Slovak writes it.
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat('sk-SK', {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(Number.isInteger(amount) ? 0 : 2)} ${currency}`;
  }
}

export function formatMoney(cents: number, currency = 'EUR'): string {
  // Slovak writes the amount first and the symbol after it, with a comma for
  // the decimal: "12,50 €". Hand-assembling "€12.50" reads as a foreign app,
  // which is exactly the wrong first impression for a product about your own
  // city.
  try {
    return new Intl.NumberFormat('sk-SK', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    // An unknown currency code should not take a screen down.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "300 m od teba" / "1,2 km od teba" — the spec's distance language. */
export function formatDistance(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined) return null;
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

export function formatDistanceFromYou(meters: number | null | undefined): string | null {
  const distance = formatDistance(meters);
  return distance ? `${distance} od teba` : null;
}

/**
 * Rough walking time at 5 km/h. Marked as an estimate because it is straight-line
 * distance — src/maps/routing.ts upgrades this to real walking directions once a
 * routing provider key is configured.
 */
export function estimateWalkingTime(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || meters > 5000) return null;
  const minutes = Math.max(1, Math.round(meters / 83));
  return `~${minutes} min pešo`;
}

/**
 * date-fns throws "Invalid time value" on an unparseable date, which takes the
 * whole screen down. A date formatter is never worth a crash: parse defensively
 * and return a placeholder so a bad row degrades to "—" instead.
 */
function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatEventDate(iso: string): string {
  const date = parse(iso);
  if (!date) return '—';

  if (isToday(date)) return `Dnes · ${format(date, 'HH:mm')}`;
  if (isTomorrow(date)) return `Zajtra · ${format(date, 'HH:mm')}`;
  if (isThisWeek(date, { weekStartsOn: 1 })) return format(date, 'EEEE · HH:mm', locale);
  return format(date, 'd. MMM · HH:mm', locale);
}

export function formatEventDateLong(iso: string): string {
  const date = parse(iso);
  return date ? format(date, 'EEEE d. MMMM yyyy · HH:mm', locale) : '—';
}

export function formatRelative(iso: string): string {
  const date = parse(iso);
  return date ? `pred ${formatDistanceToNowStrict(date, locale)}` : '—';
}

/** Clock time on a chat bubble. */
export function formatMessageTime(iso: string): string {
  const date = parse(iso);
  return date ? format(date, 'HH:mm') : '';
}

/** True when two timestamps fall on the same calendar day. */
export function isSameDay(a: string, b: string): boolean {
  const first = parse(a);
  const second = parse(b);
  if (!first || !second) return false;
  return first.toDateString() === second.toDateString();
}

/** The day separator inside a thread: "Dnes", "Včera", or a date. */
export function formatDayLabel(iso: string): string {
  const date = parse(iso);
  if (!date) return '';

  if (isToday(date)) return 'Dnes';

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Včera';

  if (isThisWeek(date, { weekStartsOn: 1 })) return format(date, 'EEEE', locale);
  return format(date, 'd. MMMM yyyy', locale);
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} tis.`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function initialsFor(name: string | null | undefined): string {
  if (!name) return '·';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Percentage string for the AI debug screen. */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 100)}%`;
}

/**
 * Where to send someone for an event.
 *
 * Prefers the readable slug and falls back to the uuid, which still resolves —
 * so a row written before slugs existed, or a caller holding nothing but an id,
 * still links somewhere real.
 */
export function eventHref(event: { id: string; slug?: string | null }): string {
  return `/event/${event.slug || event.id}`;
}

/**
 * Where to send someone for a profile. @handle if they have one, uuid if not.
 */
export function profileHref(profile: { id: string; username?: string | null }): string {
  return `/user/${profile.username ? `@${profile.username}` : profile.id}`;
}

/**
 * The gross / net / VAT split of a price.
 *
 * A price typed into BLUP is what the buyer pays, so VAT is *inside* it:
 * 12,00 € at 23 % is 9,76 € plus 2,24 €. VAT is rounded to the cent and net is
 * whatever is left, so the three numbers always add up exactly — an invoice
 * that is off by a cent is a real problem, not a rounding curiosity.
 */
export interface VatSplit {
  grossCents: number;
  netCents: number;
  vatCents: number;
  rateBps: number;
}

export function vatSplit(grossCents: number, rateBps: number): VatSplit {
  const gross = Math.max(0, Math.round(grossCents || 0));
  const rate = Math.max(0, Math.round(rateBps || 0));
  const vat = Math.round((gross * rate) / (10000 + rate));
  return { grossCents: gross, netCents: gross - vat, vatCents: vat, rateBps: rate };
}

/**
 * "s DPH 23 %" — what a buyer is told next to a price.
 *
 * Buyers see one number: the full amount. This only says that VAT is already
 * inside it, and only appears for an organizer who is registered for VAT.
 * Returns null when there is nothing true to say.
 */
export function vatIncludedLabel(
  isVatPayer: boolean | null | undefined,
  rateBps: number | null | undefined,
): string | null {
  if (!isVatPayer) return null;
  const rate = Math.max(0, Math.round(rateBps ?? 0));
  if (rate === 0) return null;
  return `s DPH ${(rate / 100).toFixed(rate % 100 === 0 ? 0 : 1)} %`;
}

/** "Brutto 12,00 € · netto 9,76 € · DPH 23 % 2,24 €" */
export function formatVatLine(grossCents: number, rateBps: number, currency = 'EUR'): string {
  const split = vatSplit(grossCents, rateBps);
  const rate = (split.rateBps / 100).toFixed(split.rateBps % 100 === 0 ? 0 : 2);
  return [
    `Brutto ${formatMoney(split.grossCents, currency)}`,
    `netto ${formatMoney(split.netCents, currency)}`,
    `DPH ${rate} % ${formatMoney(split.vatCents, currency)}`,
  ].join(' · ');
}
