const DEFAULT_TZ = "Europe/Bratislava";
const LOCALE = "sk-SK";

export function formatMoney(value: number | string | null | undefined, currency = "EUR"): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

export function formatRate(value: number | string | null | undefined, currency = "EUR"): string {
  return `${formatMoney(value, currency)} / hod.`;
}

/** `18:00` */
export function formatTime(date: Date | string | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(date));
}

/** `12. 9.` */
export function formatDateShort(date: Date | string | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "numeric", timeZone }).format(
    new Date(date),
  );
}

/** `12. septembra 2026` */
export function formatDateLong(date: Date | string | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  }).format(new Date(date));
}

/** `sobota 12. 9.` */
export function formatDateWithWeekday(
  date: Date | string | null | undefined,
  timeZone = DEFAULT_TZ,
): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "numeric",
    timeZone,
  }).format(new Date(date));
}

export function formatDateTime(date: Date | string | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!date) return "—";
  return `${formatDateShort(date, timeZone)} ${formatTime(date, timeZone)}`;
}

/** `18:00 – 00:00` */
export function formatTimeRange(
  from: Date | string,
  to: Date | string,
  timeZone = DEFAULT_TZ,
): string {
  return `${formatTime(from, timeZone)} – ${formatTime(to, timeZone)}`;
}

/** `5 h 12 min` */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** `pred 4 min`, `včera`, `12. 9.` */
export function formatRelative(date: Date | string | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!date) return "—";
  const then = new Date(date).getTime();
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);

  if (minutes < 1) return "teraz";
  if (minutes < 60) return `pred ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `pred ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "včera";
  if (days < 7) return `pred ${days} dňami`;
  return formatDateShort(date, timeZone);
}

/** ISO deň (`2026-09-12`) v časovom pásme eventu — nie v UTC. */
export function eventDayKey(date: Date | string, timeZone = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(new Date(date));
  return parts;
}

/** Hodnota pre `<input type="datetime-local">` v pásme eventu. */
export function toDateTimeLocal(date: Date | string, timeZone = DEFAULT_TZ): string {
  const d = new Date(date);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(d);
  return parts.replace(" ", "T");
}

/**
 * Opak `toDateTimeLocal` — lokálny čas v pásme eventu na skutočný `Date` (UTC).
 * Rieši to iteratívne cez offset, aby fungovalo aj cez zmenu letného času.
 */
export function fromEventLocal(value: string, timeZone = DEFAULT_TZ): Date {
  const naive = new Date(`${value}${value.length === 16 ? ":00" : ""}Z`);
  let guess = naive.getTime();
  for (let i = 0; i < 3; i += 1) {
    const rendered = toDateTimeLocal(new Date(guess), timeZone);
    const renderedMs = new Date(`${rendered}:00Z`).getTime();
    const drift = new Date(`${value.slice(0, 16)}:00Z`).getTime() - renderedMs;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess);
}

export function initials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

export function pluralSk(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  if (count >= 2 && count <= 4) return few;
  return many;
}
