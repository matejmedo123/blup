import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/admin/PageHeader";
import { Pill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SearchInput } from "@/components/ui/Filters";
import { EmptyState } from "@/components/ui/States";
import { IconMessage, IconPlus } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { CONVERSATION_TYPE_LABELS, adminConversations } from "@/lib/domain/messaging";
import { formatRelative } from "@/lib/format";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Správy" };

export default async function AdminMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const { q } = await searchParams;
  const rows = await adminConversations(context.eventId, q);
  const tz = context.event.timezone;
  const canWrite = can(context.actor, "can_message_staff");

  return (
    <>
      <PageHeader
        title="Správy"
        subtitle={`${rows.length} konverzácií na evente`}
        action={
          canWrite ? (
            <ButtonLink href="/admin/messages/nova" size="sm" icon={<IconPlus width={18} height={18} />}>
              Hromadná správa
            </ButtonLink>
          ) : null
        }
      />

      <div className="mb-5">
        <SearchInput placeholder="Hľadať konverzáciu…" className="lg:max-w-[360px]" />
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconMessage width={26} height={26} />}
            title="Žiadne konverzácie"
            description="Chat k smene vzniká automaticky pri prvom otvorení. Hromadnú správu pošleš tlačidlom vyššie."
            action={
              canWrite ? <ButtonLink href="/admin/messages/nova">Napísať crew</ButtonLink> : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-divider">
            {rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/admin/messages/${row.id}`}
                  className="flex flex-wrap items-center gap-3 p-4 transition-colors hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">
                      {row.title ?? "Priama správa"}
                    </span>
                    <span className="block truncate text-[13px] text-muted">
                      {row.memberCount} členov · {row.messageCount} správ
                      {row.lastMessageAt ? ` · ${formatRelative(row.lastMessageAt, tz)}` : ""}
                    </span>
                  </span>
                  <Pill kind={row.type === "broadcast" ? "info" : "neutral"}>
                    {CONVERSATION_TYPE_LABELS[row.type]}
                  </Pill>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
