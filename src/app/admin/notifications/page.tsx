import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { PageHeader } from "@/components/admin/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card, Kpi } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconBell } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { notifications, users } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { formatDateTime } from "@/lib/format";
import { NOTIFICATION_TYPE_LABELS } from "@/lib/labels";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Notifikácie" };

export default async function AdminNotificationsPage() {
  const context = await getAdminContext();
  if (!context) return null;

  const tz = context.event.timezone;
  const db = await getDb();

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      requiresAction: notifications.requiresAction,
      actionTakenAt: notifications.actionTakenAt,
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(eq(notifications.eventId, context.eventId))
    .orderBy(desc(notifications.createdAt))
    .limit(100);

  const unread = rows.filter((row) => !row.readAt).length;
  const awaitingAction = rows.filter((row) => row.requiresAction && !row.actionTakenAt).length;

  return (
    <>
      <PageHeader
        title="Notifikácie"
        subtitle="Čo systém posiela crew. Notifikácie vznikajú automaticky pri pridelení, zmene a pripomienke smeny."
        action={
          can(context.actor, "can_message_staff") ? (
            <ButtonLink href="/admin/messages/nova" size="sm">
              Poslať hromadnú správu
            </ButtonLink>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Kpi tone="dark" label="Odoslané" value={rows.length} note="posledných 100" />
        <Kpi label="Neprečítané" value={unread} note="crew ich ešte neotvorila" />
        <Kpi
          tone={awaitingAction > 0 ? "accent" : "plain"}
          label="Čaká na akciu"
          value={awaitingAction}
          note="nepotvrdené smeny"
        />
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconBell width={26} height={26} />}
            title="Žiadne notifikácie"
            description="Prvá notifikácia vznikne pri pridelení smeny."
          />
        ) : (
          <ul className="divide-y divide-divider">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-start gap-3 p-4">
                <Avatar
                  firstName={row.firstName}
                  lastName={row.lastName}
                  src={row.avatarUrl}
                  size="xs"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold">{row.title}</p>
                  {row.body ? <p className="mt-0.5 text-sm text-muted">{row.body}</p> : null}
                  <p className="mt-1.5 text-[13px] text-faint">
                    <Link
                      href={`/admin/staff/${row.userId}`}
                      className="font-semibold hover:text-ink"
                    >
                      {row.firstName} {row.lastName}
                    </Link>{" "}
                    · {formatDateTime(row.createdAt, tz)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill>{NOTIFICATION_TYPE_LABELS[row.type]}</Pill>
                  {row.requiresAction && !row.actionTakenAt ? (
                    <Pill kind="warn" dot>
                      Čaká
                    </Pill>
                  ) : row.readAt ? (
                    <Pill kind="ok">Prečítané</Pill>
                  ) : (
                    <Pill kind="info">Doručené</Pill>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
