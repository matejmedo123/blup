import type { Metadata } from "next";
import Link from "next/link";

import { ConfirmShiftButtons } from "@/components/portal/ConfirmShiftButtons";
import { MarkAllReadButton } from "@/components/portal/MarkAllReadButton";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconBell } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { shiftAssignments } from "@/db/schema";
import { requireStaff } from "@/lib/auth/guards";
import { getEventById } from "@/lib/domain/events";
import { portalNotifications } from "@/lib/domain/portal";
import { formatRelative } from "@/lib/format";
import { and, eq, inArray } from "drizzle-orm";

export const metadata: Metadata = { title: "Notifikácie" };

export default async function PortalNotificationsPage() {
  const session = await requireStaff();
  const rows = await portalNotifications(session.user.id);
  const event = session.eventId ? await getEventById(session.eventId) : null;
  const tz = event?.timezone ?? "Europe/Bratislava";

  // Pre notifikácie vyžadujúce akciu dohľadáme pridelenie, aby sa dalo potvrdiť priamo tu.
  const actionable = rows.filter(
    (row) => row.requiresAction && !row.actionTakenAt && row.entityId && row.entityType === "shift",
  );
  const db = await getDb();
  const assignments =
    actionable.length > 0
      ? await db
          .select({ id: shiftAssignments.id, shiftId: shiftAssignments.shiftId })
          .from(shiftAssignments)
          .where(
            and(
              eq(shiftAssignments.userId, session.user.id),
              inArray(
                shiftAssignments.shiftId,
                actionable.map((row) => row.entityId!),
              ),
              inArray(shiftAssignments.status, ["invited", "pending_confirmation"]),
            ),
          )
      : [];
  const assignmentByShift = new Map(assignments.map((a) => [a.shiftId, a.id]));

  const unread = rows.filter((row) => !row.readAt).length;

  return (
    <div className="animate-(--animate-crew-up) flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.035em] sm:text-[30px]">
          Notifikácie
        </h1>
        {unread > 0 ? <MarkAllReadButton /> : null}
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconBell width={26} height={26} />}
            title="Zatiaľ nič nové"
            description="Sem ti pošleme pridelenie smeny, pripomienky, zmeny v rozpise aj informácie o výplate."
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => {
            const assignmentId = row.entityId ? assignmentByShift.get(row.entityId) : undefined;
            const needsAction = row.requiresAction && !row.actionTakenAt && assignmentId;

            return (
              <li key={row.id}>
                <Card className={needsAction ? "p-[22px]" : "p-[18px]"}>
                  <div className="flex items-start gap-3">
                    {!row.readAt ? (
                      <span className="mt-2 size-2 shrink-0 rounded-full bg-accent-deep" aria-hidden />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <p
                        className={
                          needsAction
                            ? "eyebrow text-muted"
                            : "text-[15px] font-semibold text-ink"
                        }
                      >
                        {needsAction ? "Potvrď smenu" : row.title}
                      </p>
                      {needsAction ? (
                        <h2 className="mt-2 text-xl font-bold tracking-[-0.025em]">{row.title}</h2>
                      ) : null}
                      {row.body ? (
                        <p className="mt-1.5 text-sm leading-[1.5] text-muted">{row.body}</p>
                      ) : null}
                      <p className="mt-2 text-[13px] text-faint">
                        {formatRelative(row.createdAt, tz)}
                      </p>

                      {needsAction ? (
                        <div className="mt-4">
                          <ConfirmShiftButtons
                            assignmentId={assignmentId}
                            shiftId={row.entityId!}
                            compact
                          />
                        </div>
                      ) : row.actionUrl ? (
                        <Link
                          href={row.actionUrl}
                          className="mt-2.5 inline-block text-[13px] font-semibold underline underline-offset-4"
                        >
                          Zobraziť
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
