import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";

import { ApplicantDecision, InternalNoteEditor } from "@/components/admin/ApplicantDecision";
import { PageHeader } from "@/components/admin/PageHeader";
import { APPLICATION_STATUS_META, Pill, StatusPill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { Card, StatTile } from "@/components/ui/Card";
import { IconChevronLeft } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { applicationAnswers, auditLogs, users } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { AUDIT_ACTION_LABELS } from "@/lib/audit";
import { getApplicantDetail } from "@/lib/domain/applications";
import { formatDateLong, formatDateShort, formatDateTime } from "@/lib/format";
import { POSITION_KEY_LABELS, WORK_TYPE_LABELS } from "@/lib/labels";
import { isAdmin } from "@/lib/permissions";
import { QUESTIONS } from "@/lib/validation/application";

export const metadata: Metadata = { title: "Detail prihlášky" };

export default async function ApplicantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const { id } = await params;
  const detail = await getApplicantDetail(id, context.eventId);
  if (!detail) notFound();

  const db = await getDb();
  const [answers, history] = await Promise.all([
    db
      .select({ questionKey: applicationAnswers.questionKey, answerBool: applicationAnswers.answerBool })
      .from(applicationAnswers)
      .where(eq(applicationAnswers.applicationId, id)),
    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        createdAt: auditLogs.createdAt,
        actorFirst: users.firstName,
        actorLast: users.lastName,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(eq(auditLogs.entityId, id))
      .orderBy(desc(auditLogs.createdAt))
      .limit(20),
  ]);

  const answerMap = new Map(answers.map((a) => [a.questionKey, a.answerBool]));
  const canDecide = isAdmin(context.actor) || context.actor.eventRole === "admin";
  const age = detail.user.birthYear ? new Date().getFullYear() - detail.user.birthYear : null;

  return (
    <>
      <Link
        href="/admin/applicants"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na prihlášky
      </Link>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-4">
            <Avatar
              firstName={detail.user.firstName}
              lastName={detail.user.lastName}
              src={detail.user.avatarUrl}
              size="lg"
              tone="dark"
            />
            <span>
              {detail.user.firstName} {detail.user.lastName}
            </span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusPill status={detail.application.status} meta={APPLICATION_STATUS_META} />
            <span>
              {[
                detail.user.city,
                age ? `${age} rokov` : null,
                `prihlásená ${formatDateShort(detail.application.createdAt, context.event.timezone)}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
        }
        action={
          <ButtonLink href={`/admin/staff/${detail.user.id}`} variant="outline" size="sm">
            Profil crew
          </ButtonLink>
        }
      />

      {canDecide ? (
        <Card className="mb-5 p-5">
          <h2 className="eyebrow mb-3.5 text-muted">Rozhodnutie</h2>
          <ApplicantDecision applicationId={id} status={detail.application.status} />
          <p className="mt-3.5 text-[13px] text-muted">
            Schválenie vytvorí crew účet a otvorí portál. Smenu tým nepriradíš — to je samostatný
            krok v sekcii Prideľovanie.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-5">
          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-4 text-muted">Kontakt</h2>
            <dl className="grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
              <Detail label="E-mail" value={detail.user.email} href={`mailto:${detail.user.email}`} />
              <Detail
                label="Telefón"
                value={detail.user.phone ?? "—"}
                href={detail.user.phone ? `tel:${detail.user.phone}` : undefined}
              />
              <Detail label="Mesto" value={detail.user.city ?? "—"} />
              <Detail label="Rok narodenia" value={detail.user.birthYear?.toString() ?? "—"} />
              <Detail
                label="E-mail overený"
                value={detail.user.emailVerifiedAt ? "Áno" : "Zatiaľ nie"}
              />
              <Detail label="Stav účtu" value={detail.user.status === "active" ? "Aktívny" : "Čaká"} />
            </dl>
          </Card>

          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-4 text-muted">
              Skúsenosti ({detail.experiences.length})
            </h2>
            {detail.experiences.length === 0 ? (
              <p className="text-[15px] text-muted">Uchádzač neuviedol žiadnu skúsenosť.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-divider">
                {detail.experiences.map((experience) => (
                  <li key={experience.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[15px] font-semibold">{experience.positionLabel}</p>
                      <p className="nums text-[13px] text-faint">
                        {formatDateShort(`${experience.dateFrom}T12:00:00Z`)} —{" "}
                        {experience.dateTo
                          ? formatDateShort(`${experience.dateTo}T12:00:00Z`)
                          : "teraz"}
                      </p>
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {experience.company} ·{" "}
                      {WORK_TYPE_LABELS[experience.workType as keyof typeof WORK_TYPE_LABELS] ??
                        experience.workType}
                    </p>
                    {experience.description ? (
                      <p className="mt-2 text-sm leading-[1.6] text-body">{experience.description}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-4 text-muted">Dostupnosť</h2>
            {detail.availability.length === 0 ? (
              <p className="text-[15px] text-muted">Uchádzač neuviedol dostupnosť.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {detail.availability.map((slot) => (
                  <li
                    key={slot.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-12 bg-subtle-2 px-3.5 py-2.5"
                  >
                    <span className="text-[15px] font-medium capitalize">
                      {formatDateLong(`${slot.day}T12:00:00Z`, context.event.timezone)}
                    </span>
                    <span className="nums text-sm text-muted">
                      {slot.timeFrom} — {slot.timeTo}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {detail.availability[0]?.maxHours ? (
              <p className="mt-3.5 text-sm text-muted">
                Maximálne {detail.availability[0].maxHours} hodín za celý event.
              </p>
            ) : null}
            {detail.availability[0]?.note ? (
              <p className="mt-2 text-sm leading-[1.6] text-body">{detail.availability[0].note}</p>
            ) : null}
          </Card>

          {detail.application.motivation ? (
            <Card className="p-5 sm:p-6">
              <h2 className="eyebrow mb-3 text-muted">Motivácia</h2>
              <p className="text-[15px] leading-[1.6] text-body">{detail.application.motivation}</p>
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <div className="grid grid-cols-3 gap-2.5">
            <StatTile value={detail.score ?? 70} label="Crew Score" tone="fill" />
            <StatTile value={detail.experiences.length} label="Skúsenosti" tone="fill" />
            <StatTile value={detail.availability.length} label="Voľné dni" tone="fill" />
          </div>

          <Card className="p-5">
            <h2 className="eyebrow mb-3.5 text-muted">Preferované pozície</h2>
            {detail.positions.length === 0 ? (
              <p className="text-sm text-muted">Bez preferencie.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {detail.positions.map((key) => (
                  <Pill key={key}>
                    {POSITION_KEY_LABELS[key as keyof typeof POSITION_KEY_LABELS] ?? key}
                  </Pill>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="eyebrow mb-3.5 text-muted">Doplňujúce otázky</h2>
            <ul className="flex flex-col divide-y divide-divider">
              {QUESTIONS.map((question) => {
                const value = answerMap.get(question.key);
                return (
                  <li key={question.key} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="text-sm text-body">{question.label}</span>
                    <Pill kind={value === true ? "ok" : value === false ? "neutral" : "neutral"}>
                      {value === true ? "Áno" : value === false ? "Nie" : "—"}
                    </Pill>
                  </li>
                );
              })}
            </ul>
          </Card>

          {canDecide ? (
            <Card className="p-5">
              <InternalNoteEditor
                applicationId={id}
                initialNote={detail.application.internalNote ?? ""}
              />
            </Card>
          ) : null}

          <Card className="p-5">
            <h2 className="eyebrow mb-3.5 text-muted">História</h2>
            {history.length === 0 ? (
              <p className="text-sm text-muted">Zatiaľ žiadna zmena.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {history.map((entry) => (
                  <li key={entry.id} className="text-sm">
                    <p className="font-medium">
                      {AUDIT_ACTION_LABELS[entry.action] ?? entry.action}
                    </p>
                    <p className="text-[13px] text-faint">
                      {entry.actorFirst ? `${entry.actorFirst} ${entry.actorLast} · ` : ""}
                      {formatDateTime(entry.createdAt, context.event.timezone)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Detail({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div>
      <dt className="text-[13px] text-faint">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-medium break-words">
        {href ? (
          <a href={href} className="underline underline-offset-4 hover:text-muted">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
