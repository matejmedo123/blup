import type { Metadata } from "next";
import Link from "next/link";

import { BroadcastForm } from "@/components/admin/BroadcastForm";
import { PageHeader } from "@/components/admin/PageHeader";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconChevronLeft } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { broadcastAudienceOptions } from "@/app/actions/messaging";
import { listStaff } from "@/lib/domain/staff";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Nová hromadná správa" };

export default async function NewBroadcastPage() {
  const context = await getAdminContext();
  if (!context) return null;

  if (!can(context.actor, "can_message_staff")) {
    return (
      <Card>
        <EmptyState
          title="Nemáš oprávnenie posielať správy"
          description="Posielanie správ crew vyžaduje právo „Posielanie správ crew“."
        />
      </Card>
    );
  }

  const [options, staff] = await Promise.all([
    broadcastAudienceOptions(),
    listStaff(context.eventId, { pageSize: 500 }),
  ]);

  return (
    <>
      <Link
        href="/admin/messages"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na správy
      </Link>

      <PageHeader
        title="Hromadná správa"
        subtitle="Napíš všetkým, ľuďom na pozícii, na konkrétnej smene alebo vybraným menám."
      />

      <Card className="max-w-[720px] p-5 sm:p-7">
        <BroadcastForm
          positions={options.positions}
          shifts={options.shifts}
          staff={staff.rows.map((row) => ({
            id: row.userId,
            name: `${row.firstName} ${row.lastName}`,
          }))}
        />
      </Card>
    </>
  );
}
