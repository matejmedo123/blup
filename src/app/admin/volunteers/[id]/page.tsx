import type { Metadata } from "next";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/admin/PageHeader";
import { StatusChanger } from "@/components/admin/StatusChanger";
import { APPLICATION_STATUS_META, Pill, StatusPill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { IconChevronLeft } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { volunteerApplications } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { formatDateLong, formatDateTime } from "@/lib/format";
import { VOLUNTEER_PREFERENCE_LABELS } from "@/lib/labels";
import { isAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "Detail dobrovoľníka" };

export default async function VolunteerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const { id } = await params;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(volunteerApplications)
    .where(
      and(eq(volunteerApplications.id, id), eq(volunteerApplications.eventId, context.eventId)),
    )
    .limit(1);

  if (!row) notFound();

  return (
    <>
      <Link
        href="/admin/volunteers"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na dobrovoľníkov
      </Link>

      <PageHeader
        title={`${row.firstName} ${row.lastName}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={row.status} meta={APPLICATION_STATUS_META} />
            <span>
              {[row.city, row.birthYear ? `${row.birthYear}` : null]
                .filter(Boolean)
                .join(" · ") || "—"}
            </span>
          </span>
        }
      />

      {isAdmin(context.actor) || context.actor.eventRole === "admin" ? (
        <Card className="mb-5 p-5">
          <h2 className="eyebrow mb-3.5 text-muted">Rozhodnutie</h2>
          <StatusChanger id={id} kind="volunteer" current={row.status} />
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <Card className="p-5 sm:p-6">
          <h2 className="eyebrow mb-4 text-muted">Kontakt</h2>
          <dl className="flex flex-col gap-3.5">
            <div>
              <dt className="text-[13px] text-faint">E-mail</dt>
              <dd className="mt-0.5 text-[15px] font-medium break-words">
                <a href={`mailto:${row.email}`} className="underline underline-offset-4">
                  {row.email}
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-[13px] text-faint">Telefón</dt>
              <dd className="mt-0.5 text-[15px] font-medium">
                <a href={`tel:${row.phone}`} className="underline underline-offset-4">
                  {row.phone}
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-[13px] text-faint">Prihlásená</dt>
              <dd className="mt-0.5 text-[15px] font-medium">
                {formatDateTime(row.createdAt, context.event.timezone)}
              </dd>
            </div>
          </dl>
        </Card>

        <div className="flex flex-col gap-5">
          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-3.5 text-muted">Kde chce pomôcť</h2>
            <div className="flex flex-wrap gap-2">
              {row.preferences.length === 0 ? (
                <p className="text-sm text-muted">Bez preferencie.</p>
              ) : (
                row.preferences.map((key) => (
                  <Pill key={key}>
                    {VOLUNTEER_PREFERENCE_LABELS[key as keyof typeof VOLUNTEER_PREFERENCE_LABELS] ??
                      key}
                  </Pill>
                ))
              )}
            </div>
          </Card>

          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-3.5 text-muted">Dostupnosť</h2>
            {row.availability.length === 0 ? (
              <p className="text-sm text-muted">Neuviedol dostupnosť.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {row.availability.map((slot) => (
                  <li
                    key={slot.day}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-12 bg-subtle-2 px-3.5 py-2.5"
                  >
                    <span className="text-[15px] font-medium capitalize">
                      {formatDateLong(`${slot.day}T12:00:00Z`, context.event.timezone)}
                    </span>
                    <span className="nums text-sm text-muted">
                      {slot.from} — {slot.to}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {row.note ? (
            <Card className="p-5 sm:p-6">
              <h2 className="eyebrow mb-3 text-muted">Poznámka</h2>
              <p className="text-[15px] leading-[1.6] text-body">{row.note}</p>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
