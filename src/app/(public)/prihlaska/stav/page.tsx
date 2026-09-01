import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";

import { ResendVerificationButton } from "@/components/forms/ResendVerificationButton";
import { LogoutButton } from "@/components/layout/LogoutButton";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { APPLICATION_STATUS_META, StatusPill } from "@/components/ui/Badge";
import { EmptyState, InlineNotice } from "@/components/ui/States";
import { IconClipboard } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { applications, events, vendorApplications, volunteerApplications } from "@/db/schema";
import { requireSession } from "@/lib/auth/guards";
import { formatDateLong } from "@/lib/format";

export const metadata: Metadata = { title: "Stav prihlášky", robots: { index: false } };

const STATUS_COPY: Record<string, string> = {
  pending: "Prihlášku máme a čaká na posúdenie. Ozveme sa ti e-mailom, väčšinou do 2–3 dní.",
  reviewing: "Koordinátor si tvoju prihlášku práve prezerá. Ozveme sa ti čoskoro.",
  approved: "Si v crew. Prihlás sa do portálu a pozri si svoje smeny.",
  rejected: "Tentokrát to nevyšlo. Tvoj profil ostáva uložený — na ďalší event stačí jeden klik.",
  waitlist: "Si medzi náhradníkmi. Ak sa niekto odhlási, ozveme sa ti ako prvému.",
  archived: "Prihláška je archivovaná.",
};

export default async function ApplicationStatusPage() {
  const session = await requireSession("/prihlaska/stav");
  if (session.user.status === "active") redirect("/portal");

  const db = await getDb();

  const brigade = await db
    .select({
      id: applications.id,
      status: applications.status,
      createdAt: applications.createdAt,
      rejectionReason: applications.rejectionReason,
      eventName: events.name,
      eventStart: events.startDate,
      eventEnd: events.endDate,
      timezone: events.timezone,
    })
    .from(applications)
    .innerJoin(events, eq(events.id, applications.eventId))
    .where(eq(applications.userId, session.user.id))
    .orderBy(desc(applications.createdAt));

  const volunteer = await db
    .select({
      id: volunteerApplications.id,
      status: volunteerApplications.status,
      createdAt: volunteerApplications.createdAt,
      eventName: events.name,
    })
    .from(volunteerApplications)
    .innerJoin(events, eq(events.id, volunteerApplications.eventId))
    .where(
      and(
        sql`lower(${volunteerApplications.email}) = ${session.user.email.toLowerCase()}`,
      ),
    )
    .orderBy(desc(volunteerApplications.createdAt));

  const vendor = await db
    .select({
      id: vendorApplications.id,
      status: vendorApplications.status,
      createdAt: vendorApplications.createdAt,
      eventName: events.name,
    })
    .from(vendorApplications)
    .innerJoin(events, eq(events.id, vendorApplications.eventId))
    .where(sql`lower(${vendorApplications.email}) = ${session.user.email.toLowerCase()}`)
    .orderBy(desc(vendorApplications.createdAt));

  const hasAny = brigade.length + volunteer.length + vendor.length > 0;

  return (
    <div className="mx-auto max-w-[720px] px-5 py-12 lg:py-20">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[34px] leading-tight font-extrabold tracking-[-0.04em]">
            Tvoja prihláška<span className="text-accent-deep">.</span>
          </h1>
          <p className="mt-2 text-[15px] text-muted">
            {session.user.fullName} · {session.user.email}
          </p>
        </div>
        <LogoutButton />
      </div>

      {!session.user.emailVerifiedAt ? (
        <div className="mb-6">
          <InlineNotice tone="warning" title="E-mail ešte nie je overený">
            <p>Klikni na odkaz, ktorý sme ti poslali. Bez overenia ti nevieme posielať pripomienky smien.</p>
            <div className="mt-3">
              <ResendVerificationButton />
            </div>
          </InlineNotice>
        </div>
      ) : null}

      {!hasAny ? (
        <Card>
          <EmptyState
            icon={<IconClipboard width={26} height={26} />}
            title="Zatiaľ nemáš žiadnu prihlášku"
            description="Vyber si, prečo prichádzaš — brigáda, dobrovoľníctvo alebo stánok."
            action={<ButtonLink href="/">Pozrieť možnosti</ButtonLink>}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {brigade.map((row) => (
            <Card key={row.id} className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="eyebrow text-muted">Brigáda</p>
                  <h2 className="mt-2 text-[22px] font-extrabold tracking-[-0.03em]">
                    {row.eventName}
                  </h2>
                  <p className="mt-1 text-[14px] text-muted">
                    {formatDateLong(`${row.eventStart}T12:00:00Z`, row.timezone)} —{" "}
                    {formatDateLong(`${row.eventEnd}T12:00:00Z`, row.timezone)}
                  </p>
                </div>
                <StatusPill status={row.status} meta={APPLICATION_STATUS_META} />
              </div>
              <p className="mt-4 text-[15px] leading-[1.6] text-body">{STATUS_COPY[row.status]}</p>
              {row.status === "rejected" && row.rejectionReason ? (
                <p className="mt-2 text-[14px] text-muted">Dôvod: {row.rejectionReason}</p>
              ) : null}
              <p className="mt-4 text-[13px] text-faint">
                Odoslaná {formatDateLong(row.createdAt, row.timezone)}
              </p>
            </Card>
          ))}

          {volunteer.map((row) => (
            <Card key={row.id} className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="eyebrow text-muted">Dobrovoľník</p>
                  <h2 className="mt-2 text-[22px] font-extrabold tracking-[-0.03em]">
                    {row.eventName}
                  </h2>
                </div>
                <StatusPill status={row.status} meta={APPLICATION_STATUS_META} />
              </div>
              <p className="mt-4 text-[15px] leading-[1.6] text-body">{STATUS_COPY[row.status]}</p>
            </Card>
          ))}

          {vendor.map((row) => (
            <Card key={row.id} className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="eyebrow text-muted">Stánok</p>
                  <h2 className="mt-2 text-[22px] font-extrabold tracking-[-0.03em]">
                    {row.eventName}
                  </h2>
                </div>
                <StatusPill status={row.status} meta={APPLICATION_STATUS_META} />
              </div>
              <p className="mt-4 text-[15px] leading-[1.6] text-body">{STATUS_COPY[row.status]}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
