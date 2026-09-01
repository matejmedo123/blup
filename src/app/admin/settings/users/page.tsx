import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/admin/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { SearchInput } from "@/components/ui/Filters";
import { EmptyState } from "@/components/ui/States";
import { IconChevronLeft, IconUsers } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { listStaff } from "@/lib/domain/staff";
import { EVENT_ROLE_LABELS, PERMISSION_LABELS_SAFE } from "@/lib/labels-extra";
import { isAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "Používatelia" };

export default async function UsersSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  if (!isAdmin(context.actor) && context.actor.eventRole !== "admin") {
    return (
      <Card>
        <EmptyState title="Prístup majú len admini eventu" />
      </Card>
    );
  }

  const { q } = await searchParams;
  const result = await listStaff(context.eventId, { q, pageSize: 200 });

  return (
    <>
      <Link
        href="/admin/settings"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na nastavenia
      </Link>

      <PageHeader
        title="Používatelia"
        subtitle="Všetci ľudia s prístupom k tomuto eventu. Rolu a oprávnenia meníš v detaile človeka."
      />

      <div className="mb-5">
        <SearchInput placeholder="Hľadať meno alebo e-mail…" className="lg:max-w-[360px]" />
      </div>

      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState
            icon={<IconUsers width={26} height={26} />}
            title="Žiadni používatelia"
            description="Schválené prihlášky sa sem pridajú automaticky."
          />
        ) : (
          <ul className="divide-y divide-divider">
            {result.rows.map((row) => {
              const granted = Object.entries(row.permissions)
                .filter(([, value]) => value)
                .map(([key]) => key);
              return (
                <li key={row.userId}>
                  <Link
                    href={`/admin/staff/${row.userId}`}
                    className="flex flex-wrap items-center gap-3 p-4 transition-colors hover:bg-hover"
                  >
                    <Avatar
                      firstName={row.firstName}
                      lastName={row.lastName}
                      src={row.avatarUrl}
                      size="xs"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold">
                        {row.firstName} {row.lastName}
                      </span>
                      <span className="block truncate text-[13px] text-muted">{row.email}</span>
                    </span>

                    <span className="flex flex-wrap items-center gap-1.5">
                      {granted.slice(0, 3).map((key) => (
                        <Pill key={key}>{PERMISSION_LABELS_SAFE(key)}</Pill>
                      ))}
                      {granted.length > 3 ? <Pill>+{granted.length - 3}</Pill> : null}
                      <Pill kind={row.role === "staff" ? "neutral" : "info"}>
                        {EVENT_ROLE_LABELS[row.role]}
                      </Pill>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
