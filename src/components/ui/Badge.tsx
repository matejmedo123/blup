import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import type {
  ApplicationStatus,
  AssignmentStatus,
  AttendanceStatus,
  IncidentSeverity,
  ShiftStatus,
} from "@/db/enums";

/** Pilulka: radius 999, padding 5/11, 12px/600. Stav vždy nesie textový popis. */
export type PillKind = "ok" | "warn" | "bad" | "info" | "neutral";

const PILLS: Record<PillKind, string> = {
  ok: "bg-ok-bg text-ok-fg",
  warn: "bg-warn-bg text-warn-fg",
  bad: "bg-bad-bg text-bad-fg",
  info: "bg-info-bg text-info-fg",
  neutral: "bg-subtle text-body",
};

const DOTS: Record<PillKind, string> = {
  ok: "bg-ok-dot",
  warn: "bg-warn-dot",
  bad: "bg-bad-dot",
  info: "bg-info-dot",
  neutral: "bg-faint",
};

export function Pill({
  children,
  kind = "neutral",
  dot,
  className,
}: {
  children: ReactNode;
  kind?: PillKind;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-[11px] py-[5px] text-xs font-semibold whitespace-nowrap",
        PILLS[kind],
        className,
      )}
    >
      {dot ? <span className={cn("size-2 shrink-0 rounded-full", DOTS[kind])} aria-hidden /> : null}
      {children}
    </span>
  );
}

/** Samostatná bodka pre zoznam upozornení (§25 Alerts). */
export function StatusDot({ kind = "neutral", className }: { kind?: PillKind; className?: string }) {
  return <span className={cn("block size-2 shrink-0 rounded-full", DOTS[kind], className)} aria-hidden />;
}

type Meta = { label: string; kind: PillKind };

export const APPLICATION_STATUS_META: Record<ApplicationStatus, Meta> = {
  pending: { label: "Čaká", kind: "warn" },
  reviewing: { label: "Posudzuje sa", kind: "info" },
  approved: { label: "Schválená", kind: "ok" },
  rejected: { label: "Zamietnutá", kind: "neutral" },
  waitlist: { label: "Náhradník", kind: "neutral" },
  archived: { label: "Archív", kind: "neutral" },
};

export const SHIFT_STATUS_META: Record<ShiftStatus, Meta> = {
  draft: { label: "Koncept", kind: "neutral" },
  published: { label: "Zverejnená", kind: "info" },
  full: { label: "Obsadená", kind: "ok" },
  in_progress: { label: "Prebieha", kind: "ok" },
  completed: { label: "Ukončená", kind: "neutral" },
  cancelled: { label: "Zrušená", kind: "bad" },
};

export const ASSIGNMENT_STATUS_META: Record<AssignmentStatus, Meta> = {
  invited: { label: "Pozvaný", kind: "info" },
  pending_confirmation: { label: "Čaká na potvrdenie", kind: "warn" },
  confirmed: { label: "Potvrdená", kind: "ok" },
  declined: { label: "Odmietnutá", kind: "bad" },
  cancelled: { label: "Zrušená", kind: "neutral" },
  completed: { label: "Odpracovaná", kind: "neutral" },
};

export const ATTENDANCE_STATUS_META: Record<AttendanceStatus, Meta> = {
  not_started: { label: "Nezačaté", kind: "neutral" },
  checked_in: { label: "Pracuje", kind: "ok" },
  checked_out: { label: "Hotovo", kind: "neutral" },
  late: { label: "Meškal check-in", kind: "warn" },
  missing: { label: "Chýba", kind: "bad" },
  manually_corrected: { label: "Opravené", kind: "info" },
};

export const INCIDENT_SEVERITY_META: Record<IncidentSeverity, Meta> = {
  low: { label: "Nízka", kind: "neutral" },
  medium: { label: "Stredná", kind: "info" },
  high: { label: "Vysoká", kind: "warn" },
  critical: { label: "Kritická", kind: "bad" },
};

export function StatusPill<T extends string>({
  status,
  meta,
  dot = true,
}: {
  status: T;
  meta: Record<string, Meta>;
  dot?: boolean;
}) {
  const entry = meta[status] ?? { label: status, kind: "neutral" as PillKind };
  return (
    <Pill kind={entry.kind} dot={dot}>
      {entry.label}
    </Pill>
  );
}
