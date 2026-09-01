import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/admin/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconChevronLeft, IconShield } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { listStaff } from "@/lib/domain/staff";
import { EVENT_ROLE_LABELS } from "@/lib/labels";
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
  isAdmin,
} from "@/lib/permissions";

export const metadata: Metadata = { title: "Oprávnenia" };

export default async function PermissionsPage() {
  const context = await getAdminContext();
  if (!context) return null;

  if (!isAdmin(context.actor) && context.actor.eventRole !== "admin") {
    return (
      <Card>
        <EmptyState title="Prístup majú len admini eventu" />
      </Card>
    );
  }

  const result = await listStaff(context.eventId, { pageSize: 500 });
  const leads = result.rows.filter((row) => row.role !== "staff");

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
        title="Oprávnenia"
        subtitle="Koordinátor má len tie práva, ktoré mu výslovne udelíš. Admin má všetky."
      />

      <Card className="mb-5 p-5 sm:p-6">
        <h2 className="section-label mb-4">Čo jednotlivé práva znamenajú</h2>
        <ul className="flex flex-col divide-y divide-divider">
          {PERMISSION_KEYS.map((key) => (
            <li key={key} className="py-3.5 first:pt-0 last:pb-0">
              <p className="text-[15px] font-semibold">{PERMISSION_LABELS[key]}</p>
              <p className="mt-0.5 text-sm text-muted">{PERMISSION_DESCRIPTIONS[key]}</p>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-line p-5">
          <h2 className="section-label">Kto má rozšírené práva</h2>
        </div>
        {leads.length === 0 ? (
          <EmptyState
            icon={<IconShield width={26} height={26} />}
            title="Zatiaľ len crew"
            description="Nikto nemá rolu koordinátora ani admina. Rolu zmeníš v detaile človeka."
          />
        ) : (
          <ul className="divide-y divide-divider">
            {leads.map((row) => {
              const granted = PERMISSION_KEYS.filter((key) => row.permissions[key]);
              return (
                <li key={row.userId}>
                  <Link
                    href={`/admin/staff/${row.userId}`}
                    className="flex flex-wrap items-start gap-3 p-4 transition-colors hover:bg-hover"
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
                      <span className="mt-1.5 flex flex-wrap gap-1.5">
                        {row.role === "admin" ? (
                          <Pill kind="info">Všetky práva</Pill>
                        ) : granted.length === 0 ? (
                          <Pill kind="warn">Bez práv — nič nezmôže</Pill>
                        ) : (
                          granted.map((key) => <Pill key={key}>{PERMISSION_LABELS[key]}</Pill>)
                        )}
                      </span>
                    </span>
                    <Pill kind="info">{EVENT_ROLE_LABELS[row.role]}</Pill>
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
