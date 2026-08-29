import { ORDER_CONFIG } from "./config";

const priceFormatter = new Intl.NumberFormat(ORDER_CONFIG.locale, {
  style: "currency",
  currency: ORDER_CONFIG.currency,
  minimumFractionDigits: 2,
});

/** "7,90 €" — slovenský formát meny. */
export function formatPrice(value: number): string {
  return priceFormatter.format(round2(value));
}

/** "€7.90" — kompaktný zápis pre tlačenú účtenku a CTA tlačidlá. */
export function formatPriceCompact(value: number): string {
  return `${round2(value).toFixed(2)} €`;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(ORDER_CONFIG.locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
