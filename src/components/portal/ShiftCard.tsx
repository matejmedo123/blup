import Link from "next/link";

import { ASSIGNMENT_STATUS_META, StatusPill } from "@/components/ui/Badge";
import type { AssignmentStatus } from "@/db/enums";

/** Karta smeny v zozname — plocha celej karty je klikateľná. */
export function ShiftCard({
  href,
  title,
  when,
  place,
  rate,
  hours,
  status,
}: {
  href: string;
  title: string;
  when: string;
  place: string;
  rate: string;
  hours: string;
  status?: AssignmentStatus | string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3.5 rounded-16 border border-line bg-surface p-[18px] transition-colors hover:bg-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] font-bold tracking-[-0.02em]">{title}</span>
        <span className="nums mt-1 block truncate text-[13px] text-muted">{when}</span>
        <span className="block truncate text-[13px] text-muted">{place}</span>
        {status ? (
          <span className="mt-2 block">
            <StatusPill status={status} meta={ASSIGNMENT_STATUS_META} />
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-right">
        <span className="nums block text-base font-bold">{rate}</span>
        <span className="nums block text-xs text-muted">{hours}</span>
      </span>
    </Link>
  );
}
