import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";

import { CrewScoreRing } from "@/components/admin/CrewScoreRing";
import { DetailTabs } from "@/components/admin/DetailTabs";
import { PageHeader } from "@/components/admin/PageHeader";
import { StaffNoteForm } from "@/components/admin/StaffNoteForm";
import { StaffRoleForm } from "@/components/admin/StaffRoleForm";
import { MessageUserButton } from "@/components/portal/OpenConversationButton";
import { Avatar } from "@/components/ui/Avatar";
import {
  ASSIGNMENT_STATUS_META,
  ATTENDANCE_STATUS_META,
  Pill,
  StatusPill,
} from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card, StatTile } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconChevronLeft, IconClipboard } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import type { AttendanceStatus } from "@/db/enums";
import { auditLogs, experiences, messages, staffNotes, users } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { AUDIT_ACTION_LABELS } from "@/lib/audit";
import { attendanceForUser } from "@/lib/domain/attendance";
import { eventSettings } from "@/lib/domain/events";
import { calculateEarnings } from "@/lib/domain/payroll";
import { scoreHistory } from "@/lib/domain/score";
import { averageRating, getStaffMember, staffRatings, staffShifts } from "@/lib/domain/staff";
import {
  formatDateShort,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatTimeRange,
} from "@/lib/format";
import { EVENT_ROLE_LABELS, PERMISSION_LABELS_SAFE, WORK_TYPE_LABELS } from "@/lib/labels-extra";
import { isAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "Detail crew" };

const TABS = [
  { value: "profile", label: "Profil" },
  { value: "experience", label: "Skúsenosti" },
  { value: "shifts", label: "Smeny" },
  { value: "attendance", label: "Dochádzka" },
  { value: "earnings", label: "Zárobky" },
  { value: "rating", label: "Hodnotenia" },
  { value: "score", label: "Crew Score" },
  { value: "notes", label: "Poznámky" },
  { value: "activity", label: "Aktivita" },
];

export default async function StaffDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const { id } = await params;
  const { tab } = await searchParams;
  const activeTab = TABS.some((t) => t.value === tab) ? tab! : "profile";

  const member = await getStaffMember(id, context.eventId);
  if (!member) notFound();

  const tz = context.event.timezone;
  const settings = eventSettings(context.event);
  const db = await getDb();

  const [shiftRows, attendanceRows, ratingRows, avgRating, scoreRows, experienceRows, noteRows, activityRows, messageCount] =
    await Promise.all([
      staffShifts(id, context.eventId),
      attendanceForUser(id, context.eventId),
      staffRatings(id, context.eventId),
      averageRating(id, context.eventId),
      scoreHistory(id, context.eventId),
      db.select().from(experiences).where(eq(experiences.userId, id)).orderBy(desc(experiences.dateFrom)),
      db
        .select({
          id: staffNotes.id,
          body: staffNotes.body,
          createdAt: staffNotes.createdAt,
          authorFirst: users.firstName,
          authorLast: users.lastName,
        })
        .from(staffNotes)
        .innerJoin(users, eq(users.id, staffNotes.authorId))
        .where(and(eq(staffNotes.staffId, id), eq(staffNotes.eventId, context.eventId)))
        .orderBy(desc(staffNotes.createdAt)),
      db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entity: auditLogs.entity,
          createdAt: auditLogs.createdAt,
          actorFirst: users.firstName,
          actorLast: users.lastName,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorId))
        .where(and(eq(auditLogs.entityId, id), eq(auditLogs.eventId, context.eventId)))
        .orderBy(desc(auditLogs.createdAt))
        .limit(30),
      db.select({ id: messages.id }).from(messages).where(eq(messages.senderId, id)).limit(200),
    ]);

  const totalMinutes = attendanceRows.reduce((sum, row) => sum + (row.workedMinutes ?? 0), 0);
  const approvedMinutes = attendanceRows
    .filter((row) => row.approved)
    .reduce((sum, row) => sum + (row.workedMinutes ?? 0), 0);
  const noShows = attendanceRows.filter((row) => row.status === "missing").length;
  const completedShifts = shiftRows.filter((row) => row.status === "completed").length;

  const earningRows = attendanceRows.map((row) => {
    const rate = Number(row.hourlyRate ?? row.positionRate) || 0;
    return {
      ...row,
      rate,
      earnings: calculateEarnings(
        {
          workedMinutes: row.workedMinutes ?? 0,
          hourlyRate: rate,
          bonus: Number(row.bonus ?? 0),
          adjustments: Number(row.adjustments ?? 0),
        },
        settings,
      ),
    };
  });
  const totalEarned = earningRows.reduce((sum, row) => sum + row.earnings.total, 0);
  const approvedEarned = earningRows
    .filter((row) => row.approved)
    .reduce((sum, row) => sum + row.earnings.total, 0);

  const attendanceRate =
    shiftRows.length > 0
      ? Math.round(((shiftRows.length - noShows) / shiftRows.length) * 100)
      : 100;

  const canManage = isAdmin(context.actor) || context.actor.eventRole === "admin";

  return (
    <>
      <Link
        href="/admin/staff"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na crew
      </Link>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-4">
            <Avatar
              firstName={member.user.firstName}
              lastName={member.user.lastName}
              src={member.user.avatarUrl}
              size="lg"
              tone="dark"
            />
            <span>
              {member.user.firstName} {member.user.lastName}
            </span>
          </span>
        }
        subtitle={[
          EVENT_ROLE_LABELS[member.role],
          member.user.city,
          `${shiftRows.length} ${shiftRows.length === 1 ? "smena" : shiftRows.length < 5 ? "smeny" : "smien"}`,
        ]
          .filter(Boolean)
          .join(" · ")}
        action={
          <>
            <ButtonLink href={`/admin/assignments?user=${id}`} variant="dark" size="sm">
              Priradiť na smenu
            </ButtonLink>
            <MessageUserButton userId={id} target="admin" variant="outline" size="sm" />
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile value={member.score} label="Crew Score" tone="fill" />
        <StatTile value={`${attendanceRate} %`} label="Dochádzka" tone="fill" />
        <StatTile value={noShows} label="No-show" tone="fill" />
        <StatTile value={formatDuration(totalMinutes)} label="Odpracované" tone="fill" />
      </div>

      <DetailTabs
        basePath={`/admin/staff/${id}`}
        activeTab={activeTab}
        tabs={TABS.map((t) => ({
          ...t,
          count:
            t.value === "shifts"
              ? shiftRows.length
              : t.value === "experience"
                ? experienceRows.length
                : t.value === "rating"
                  ? ratingRows.length
                  : t.value === "notes"
                    ? noteRows.length
                    : undefined,
        }))}
      />

      {activeTab === "profile" ? (
        <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-4 text-muted">Osobné údaje</h2>
            <dl className="grid gap-3.5 sm:grid-cols-2">
              <Field label="E-mail" value={member.user.email} href={`mailto:${member.user.email}`} />
              <Field
                label="Telefón"
                value={member.user.phone ?? "—"}
                href={member.user.phone ? `tel:${member.user.phone}` : undefined}
              />
              <Field label="Mesto" value={member.user.city ?? "—"} />
              <Field label="Rok narodenia" value={member.user.birthYear?.toString() ?? "—"} />
              <Field
                label="E-mail overený"
                value={member.user.emailVerifiedAt ? formatDateShort(member.user.emailVerifiedAt, tz) : "Nie"}
              />
              <Field
                label="Posledné prihlásenie"
                value={member.user.lastLoginAt ? formatDateTime(member.user.lastLoginAt, tz) : "Nikdy"}
              />
              <Field label="Správ odoslaných" value={String(messageCount.length)} />
              <Field label="V systéme od" value={formatDateShort(member.user.createdAt, tz)} />
            </dl>
          </Card>

          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-4 text-muted">Rola a oprávnenia</h2>
            {canManage ? (
              <StaffRoleForm
                userId={id}
                role={member.role}
                permissions={member.permissions}
                accountStatus={member.user.status}
              />
            ) : (
              <>
                <Pill kind="info">{EVENT_ROLE_LABELS[member.role]}</Pill>
                <ul className="mt-4 flex flex-wrap gap-2">
                  {Object.entries(member.permissions)
                    .filter(([, value]) => value)
                    .map(([key]) => (
                      <Pill key={key}>{PERMISSION_LABELS_SAFE(key)}</Pill>
                    ))}
                </ul>
              </>
            )}
          </Card>
        </div>
      ) : null}

      {activeTab === "experience" ? (
        <Card className="p-5 sm:p-6">
          {experienceRows.length === 0 ? (
            <EmptyState
              icon={<IconClipboard width={26} height={26} />}
              title="Žiadne skúsenosti"
              description="Pracovník neuviedol v prihláške žiadnu pracovnú skúsenosť."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-divider">
              {experienceRows.map((experience) => (
                <li key={experience.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[15px] font-semibold">{experience.positionLabel}</p>
                    <p className="nums text-[13px] text-faint">
                      {formatDateShort(`${experience.dateFrom}T12:00:00Z`)} —{" "}
                      {experience.dateTo ? formatDateShort(`${experience.dateTo}T12:00:00Z`) : "teraz"}
                    </p>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {experience.company} · {WORK_TYPE_LABELS(experience.workType)}
                  </p>
                  {experience.description ? (
                    <p className="mt-2 text-sm leading-[1.6] text-body">{experience.description}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {activeTab === "shifts" ? (
        <Card className="overflow-hidden">
          {shiftRows.length === 0 ? (
            <EmptyState
              title="Žiadne smeny"
              description="Tento človek zatiaľ nemá pridelenú žiadnu smenu."
              action={
                <ButtonLink href={`/admin/assignments?user=${id}`} size="sm">
                  Priradiť na smenu
                </ButtonLink>
              }
            />
          ) : (
            <ul className="divide-y divide-divider">
              {shiftRows.map((row) => (
                <li key={row.assignmentId}>
                  <Link
                    href={`/admin/shifts/${row.shiftId}`}
                    className="flex flex-wrap items-center justify-between gap-3 p-4 transition-colors hover:bg-hover"
                  >
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold">{row.positionName}</p>
                      <p className="nums mt-0.5 text-[13px] text-muted">
                        {formatDateShort(row.startsAt, tz)} ·{" "}
                        {formatTimeRange(row.startsAt, row.endsAt, tz)}
                        {row.location ? ` · ${row.location}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {row.needsReplacement ? <Pill kind="bad">Potrebuje náhradu</Pill> : null}
                      <StatusPill status={row.status} meta={ASSIGNMENT_STATUS_META} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {activeTab === "attendance" ? (
        <Card className="overflow-hidden">
          {attendanceRows.length === 0 ? (
            <EmptyState
              title="Žiadna dochádzka"
              description="Check-in sa objaví hneď, ako pracovník začne prvú smenu."
            />
          ) : (
            <ul className="divide-y divide-divider">
              {attendanceRows.map((row) => (
                <li key={row.attendanceId} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold">{row.positionName}</p>
                    <p className="nums mt-0.5 text-[13px] text-muted">
                      {formatDateShort(row.startsAt, tz)} · check-in{" "}
                      {row.checkInAt ? formatDateTime(row.checkInAt, tz) : "—"} · check-out{" "}
                      {row.checkOutAt ? formatDateTime(row.checkOutAt, tz) : "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="nums text-sm font-semibold">
                      {formatDuration(row.workedMinutes)}
                    </span>
                    <StatusPill
                      status={row.status as AttendanceStatus}
                      meta={ATTENDANCE_STATUS_META}
                    />
                    {row.approved ? <Pill kind="ok">Schválené</Pill> : <Pill kind="warn">Čaká</Pill>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {activeTab === "earnings" ? (
        <div className="flex min-w-0 flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-5">
              <p className="text-[13px] text-muted">Odhad zo všetkej dochádzky</p>
              <p className="nums mt-2 text-[32px] leading-none font-extrabold tracking-[-0.045em]">
                {formatMoney(totalEarned, settings.currency)}
              </p>
              <p className="mt-2 text-[13px] text-muted">{formatDuration(totalMinutes)}</p>
            </Card>
            <Card className="p-5">
              <p className="text-[13px] text-muted">Schválené na výplatu</p>
              <p className="nums mt-2 text-[32px] leading-none font-extrabold tracking-[-0.045em]">
                {formatMoney(approvedEarned, settings.currency)}
              </p>
              <p className="mt-2 text-[13px] text-muted">{formatDuration(approvedMinutes)}</p>
            </Card>
            <Card className="p-5">
              <p className="text-[13px] text-muted">Odpracované smeny</p>
              <p className="nums mt-2 text-[32px] leading-none font-extrabold tracking-[-0.045em]">
                {completedShifts}
              </p>
              <p className="mt-2 text-[13px] text-muted">z {shiftRows.length} pridelených</p>
            </Card>
          </div>

          <Card className="overflow-hidden">
            {earningRows.length === 0 ? (
              <EmptyState title="Zatiaľ žiadny zárobok" description="Zárobok vzniká z odpracovaných smien." />
            ) : (
              <ul className="divide-y divide-divider">
                {earningRows.map((row) => (
                  <li
                    key={row.attendanceId}
                    className="flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold">{row.positionName}</p>
                      <p className="nums mt-0.5 text-[13px] text-muted">
                        {formatDateShort(row.startsAt, tz)} · {row.earnings.hours} h ×{" "}
                        {formatMoney(row.rate, settings.currency)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {!row.approved ? <Pill kind="warn">Neschválené</Pill> : null}
                      <span className="nums text-base font-bold">
                        {formatMoney(row.earnings.total, settings.currency)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      {activeTab === "rating" ? (
        <div className="flex min-w-0 flex-col gap-5">
          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-3 text-muted">Priemerné hodnotenie</h2>
            <p className="nums text-[32px] leading-none font-extrabold tracking-[-0.045em]">
              {avgRating != null ? `${avgRating.toFixed(2)} / 5` : "—"}
            </p>
            <p className="mt-2 text-[13px] text-muted">
              {ratingRows.length === 0
                ? "Zatiaľ bez hodnotenia."
                : `${ratingRows.length} ${ratingRows.length === 1 ? "hodnotenie" : ratingRows.length < 5 ? "hodnotenia" : "hodnotení"}`}
            </p>
          </Card>

          {ratingRows.length > 0 ? (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-divider">
                {ratingRows.map((rating) => (
                  <li key={rating.id} className="p-4 sm:p-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[15px] font-semibold">
                        {rating.positionName ?? "Celkové hodnotenie"}
                      </p>
                      <p className="nums text-base font-bold">{Number(rating.overall).toFixed(2)} / 5</p>
                    </div>
                    <p className="mt-1 text-[13px] text-muted">
                      {rating.raterFirstName} {rating.raterLastName} ·{" "}
                      {formatDateShort(rating.createdAt, tz)}
                    </p>
                    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
                      <Score label="Spoľahlivosť" value={rating.reliability} />
                      <Score label="Dochvíľnosť" value={rating.punctuality} />
                      <Score label="Pracovitosť" value={rating.workEthic} />
                      <Score label="Komunikácia" value={rating.communication} />
                      <Score label="Kvalita" value={rating.quality} />
                    </dl>
                    {rating.note ? (
                      <p className="mt-3 text-sm leading-[1.6] text-body">{rating.note}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}

      {activeTab === "score" ? (
        <div className="grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
          <Card className="flex items-center gap-6 p-5 sm:p-6">
            <CrewScoreRing score={member.score} />
            <div>
              <p className="eyebrow text-muted">Crew Score</p>
              <p className="mt-2 max-w-[220px] text-[13px] leading-[1.5] text-muted">
                Rastie za dochvíľnosť a potvrdzovanie smien, klesá za meškanie a no-show.
              </p>
            </div>
          </Card>

          <Card className="overflow-hidden">
            {scoreRows.length === 0 ? (
              <EmptyState
                title="Žiadna zmena skóre"
                description="Skóre sa začne meniť po prvej odpracovanej smene."
              />
            ) : (
              <ul className="divide-y divide-divider">
                {scoreRows.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="text-[15px] font-medium">{row.reason ?? row.ruleKey}</p>
                      <p className="text-[13px] text-faint">{formatDateTime(row.createdAt, tz)}</p>
                    </div>
                    <Pill kind={row.delta >= 0 ? "ok" : "bad"}>
                      {row.delta > 0 ? `+${row.delta}` : row.delta}
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      {activeTab === "notes" ? (
        <div className="flex min-w-0 flex-col gap-5">
          {canManage ? (
            <Card className="p-5">
              <StaffNoteForm staffId={id} />
            </Card>
          ) : null}
          <Card className="overflow-hidden">
            {noteRows.length === 0 ? (
              <EmptyState
                title="Žiadne poznámky"
                description="Interné poznámky vidí len admin tím. Pracovník ich nikdy neuvidí."
              />
            ) : (
              <ul className="divide-y divide-divider">
                {noteRows.map((note) => (
                  <li key={note.id} className="p-4 sm:p-5">
                    <p className="text-[15px] leading-[1.6] text-body">{note.body}</p>
                    <p className="mt-2 text-[13px] text-faint">
                      {note.authorFirst} {note.authorLast} · {formatDateTime(note.createdAt, tz)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      {activeTab === "activity" ? (
        <Card className="overflow-hidden">
          {activityRows.length === 0 ? (
            <EmptyState title="Žiadna aktivita" description="Zmeny na tomto profile sa tu zobrazia." />
          ) : (
            <ul className="divide-y divide-divider">
              {activityRows.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="text-[15px] font-medium">
                      {AUDIT_ACTION_LABELS[entry.action] ?? entry.action}
                    </p>
                    <p className="text-[13px] text-faint">
                      {entry.actorFirst ? `${entry.actorFirst} ${entry.actorLast} · ` : ""}
                      {formatDateTime(entry.createdAt, tz)}
                    </p>
                  </div>
                  <Pill>{entry.entity}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </>
  );
}

function Field({ label, value, href }: { label: string; value: string; href?: string }) {
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

function Score({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="nums font-semibold">{value}/5</dd>
    </div>
  );
}
