import { format, formatDistanceToNowStrict, isToday, isTomorrow, isThisWeek } from 'date-fns';
import { sk } from 'date-fns/locale';

/** Every date in the app is rendered in Slovak. */
const locale = { locale: sk };

/** Money is stored in minor units; never format a float. */
export function formatPrice(cents: number, currency = 'EUR'): string {
  if (cents === 0) return 'Zdarma';
  const amount = cents / 100;
  const symbols: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', CZK: 'Kč', PLN: 'zł' };
  const symbol = symbols[currency] ?? currency;
  const value = Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2);
  return currency === 'CZK' || currency === 'PLN' ? `${value} ${symbol}` : `${symbol}${value}`;
}

export function formatMoney(cents: number, currency = 'EUR'): string {
  const amount = (cents / 100).toFixed(2);
  const symbols: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };
  return `${symbols[currency] ?? `${currency} `}${amount}`;
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
