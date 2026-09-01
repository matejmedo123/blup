"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { Pill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconCalendar, IconChevronLeft, IconChevronRight } from "@/components/ui/Icons";
import { cn } from "@/lib/cn";
import { formatTimeRange } from "@/lib/format";

export type CalendarShift = {
  id: string;
  positionName: string;
  positionColor: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  capacity: number;
  filled: number;
  status: string;
};

/** Časové pásy týždňového pohľadu — zhodné s prototypom. */
const SLOTS = [
  { label: "10:00", from: 6, to: 12 },
  { label: "14:00", from: 12, to: 16 },
  { label: "18:00", from: 16, to: 21 },
  { label: "22:00", from: 21, to: 30 },
];

export function ShiftCalendar({
  days,
  shifts,
  timezone,
  weekStart,
  canManage,
  view,
}: {
  days: string[];
  shifts: CalendarShift[];
  timezone: string;
  weekStart: string;
  canManage: boolean;
  view: "week" | "list";
}) {
  const router = useRouter();
  const params = useSearchParams();

  function shiftWeek(deltaDays: number) {
    const next = new Date(`${weekStart}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + deltaDays);
    const search = new URLSearchParams(params.toString());
    search.set("week", next.toISOString().slice(0, 10));
    router.replace(`/admin/calendar?${search.toString()}`, { scroll: false });
  }

  function setView(next: "week" | "list") {
    const search = new URLSearchParams(params.toString());
    search.set("view", next);
    router.replace(`/admin/calendar?${search.toString()}`, { scroll: false });
  }

  const byDay = new Map<string, CalendarShift[]>();
  for (const shift of shifts) {
    const key = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: timezone,
    }).format(new Date(shift.startsAt));
    const list = byDay.get(key) ?? [];
    list.push(shift);
    byDay.set(key, list);
  }

  const todayKey = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).format(new Date());

  function hourIn(shift: CalendarShift): number {
    const hh = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(new Date(shift.startsAt));
    return Number(hh);
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shiftWeek(-7)}
            className="touch flex cursor-pointer items-center justify-center rounded-10 border border-line-strong bg-surface"
            aria-label="Predchádzajúci týždeň"
          >
            <IconChevronLeft width={18} height={18} />
          </button>
          <button
            type="button"
            onClick={() => shiftWeek(7)}
            className="touch flex cursor-pointer items-center justify-center rounded-10 border border-line-strong bg-surface"
            aria-label="Nasledujúci týždeň"
          >
            <IconChevronRight width={18} height={18} />
          </button>
        </div>

        <div className="ml-auto flex gap-2">
          {(["week", "list"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setView(value)}
              aria-pressed={view === value}
              className={cn(
                "min-h-10 cursor-pointer rounded-10 px-3.5 text-[13px] font-semibold transition-colors",
                view === value
                  ? "bg-ink text-white"
                  : "border border-line-strong bg-surface text-muted hover:bg-hover",
              )}
            >
              {value === "week" ? "Týždeň" : "Zoznam"}
            </button>
          ))}
        </div>
      </div>

      {/* Týždenná mriežka — len na širokých obrazovkách (§69: mobil dostane agendu). */}
      {view === "week" ? (
        <Card className="hidden overflow-hidden p-5 lg:block">
          <div className="mb-3 grid grid-cols-[64px_repeat(7,minmax(0,1fr))] gap-2.5">
            <span />
            {days.map((day) => (
              <span
                key={day}
                className={cn(
                  "px-0.5 py-1 text-[13px] font-semibold capitalize",
                  day === todayKey ? "text-ink" : "text-faint",
                )}
              >
                {new Intl.DateTimeFormat("sk-SK", {
                  weekday: "short",
                  day: "numeric",
                  timeZone: timezone,
                }).format(new Date(`${day}T12:00:00Z`))}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))] gap-2.5">
            <div className="nums flex flex-col gap-2.5 text-xs text-faint">
              {SLOTS.map((slot) => (
                <span key={slot.label} className="flex h-16 items-start">
                  {slot.label}
                </span>
              ))}
            </div>

            {days.map((day) => (
              <div key={day} className="flex flex-col gap-2.5">
                {SLOTS.map((slot) => {
                  const inSlot = (byDay.get(day) ?? []).filter((shift) => {
                    const hour = hourIn(shift);
                    return hour >= slot.from && hour < slot.to;
                  });

                  if (inSlot.length === 0) {
                    return canManage ? (
                      <Link
                        key={slot.label}
                        href={`/admin/shifts/nova?date=${day}`}
                        className="photo-slot flex h-16 items-center justify-center rounded-12 text-[11px] font-medium text-faint opacity-0 transition-opacity hover:opacity-100"
                        aria-label={`Vytvoriť smenu ${day} o ${slot.label}`}
                      >
                        + smena
                      </Link>
                    ) : (
                      <div key={slot.label} className="photo-slot h-16 rounded-12" aria-hidden />
                    );
                  }

                  const shift = inSlot[0];
                  const critical = shift.filled === 0;
                  const understaffed = shift.filled < shift.capacity;

                  return (
                    <Link
                      key={slot.label}
                      href={`/admin/shifts/${shift.id}`}
                      className={cn(
                        "flex h-16 min-w-0 flex-col justify-center overflow-hidden rounded-12 px-3 py-2.5 transition-opacity hover:opacity-90",
                        critical
                          ? "bg-accent text-ink"
                          : understaffed
                            ? "bg-subtle text-ink"
                            : "bg-ink text-white",
                      )}
                    >
                      <span className="truncate text-xs font-bold tracking-[-0.01em]">
                        {shift.positionName}
                      </span>
                      <span className="nums mt-0.5 truncate text-[11px] opacity-70">
                        {shift.filled} / {shift.capacity}
                        {inSlot.length > 1 ? ` · +${inSlot.length - 1}` : ""}
                      </span>
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* Agenda — mobil vždy, desktop pri prepnutí na zoznam. */}
      <div className={view === "week" ? "lg:hidden" : ""}>
        {shifts.length === 0 ? (
          <Card>
            <EmptyState
              icon={<IconCalendar width={26} height={26} />}
              title="Tento týždeň žiadna smena"
              description="Prepni týždeň alebo vytvor novú smenu."
              action={
                canManage ? <ButtonLink href="/admin/shifts/nova">Vytvoriť smenu</ButtonLink> : undefined
              }
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-5">
            {days
              .filter((day) => (byDay.get(day) ?? []).length > 0)
              .map((day) => (
                <div key={day}>
                  <div className="mb-2.5 flex items-baseline justify-between gap-3">
                    <h2
                      className={cn(
                        "text-[15px] font-bold capitalize",
                        day === todayKey ? "text-ink" : "text-muted",
                      )}
                    >
                      {new Intl.DateTimeFormat("sk-SK", {
                        weekday: "long",
                        day: "numeric",
                        month: "long",
                        timeZone: timezone,
                      }).format(new Date(`${day}T12:00:00Z`))}
                    </h2>
                    {canManage ? (
                      <Link
                        href={`/admin/shifts/nova?date=${day}`}
                        className="-mr-2 flex min-h-11 items-center px-2 text-[13px] font-semibold text-muted hover:text-ink"
                      >
                        + smena
                      </Link>
                    ) : null}
                  </div>

                  <Card className="overflow-hidden">
                    <ul className="divide-y divide-divider">
                      {(byDay.get(day) ?? [])
                        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
                        .map((shift) => (
                          <li key={shift.id}>
                            <Link
                              href={`/admin/shifts/${shift.id}`}
                              className="flex items-center gap-3 p-4 transition-colors hover:bg-hover"
                            >
                              <span
                                className="size-2.5 shrink-0 rounded-[3px]"
                                style={{ background: shift.positionColor }}
                                aria-hidden
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[15px] font-semibold">
                                  {shift.positionName}
                                </span>
                                <span className="nums block truncate text-[13px] text-muted">
                                  {formatTimeRange(shift.startsAt, shift.endsAt, timezone)}
                                  {shift.location ? ` · ${shift.location}` : ""}
                                </span>
                              </span>
                              {shift.filled >= shift.capacity ? (
                                <Pill kind="ok" dot>
                                  {shift.filled}/{shift.capacity}
                                </Pill>
                              ) : shift.filled === 0 ? (
                                <Pill kind="bad" dot>
                                  {shift.filled}/{shift.capacity}
                                </Pill>
                              ) : (
                                <Pill kind="warn" dot>
                                  {shift.filled}/{shift.capacity}
                                </Pill>
                              )}
                            </Link>
                          </li>
                        ))}
                    </ul>
                  </Card>
                </div>
              ))}
          </div>
        )}
      </div>
    </>
  );
}
