import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/admin/AdminShell";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconCalendar } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { EVENT_ROLE_LABELS, GLOBAL_ROLE_LABELS } from "@/lib/labels";
import { visibleAdminSections } from "@/lib/permissions";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · CREW. admin" },
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const context = await getAdminContext();

  if (!context) {
    return (
      <div className="mx-auto max-w-[720px] px-5 py-20">
        <Card>
          <EmptyState
            icon={<IconCalendar width={26} height={26} />}
            title="Zatiaľ nemáš žiadny event"
            description="Admin rozhranie potrebuje aspoň jeden event. Vytvor ho v nastaveniach."
            action={<ButtonLink href="/admin/settings/event/novy">Vytvoriť event</ButtonLink>}
          />
          <p className="border-t border-line px-6 py-4 text-center text-[13px] text-muted">
            <Link href="/" className="underline underline-offset-4">
              Späť na web
            </Link>
          </p>
        </Card>
      </div>
    );
  }

  const roleLabel =
    context.actor.eventRole === "coordinator"
      ? EVENT_ROLE_LABELS.coordinator
      : GLOBAL_ROLE_LABELS[context.user.globalRole];

  return (
    <AdminShell
      user={{
        firstName: context.user.firstName,
        lastName: context.user.lastName,
        avatarUrl: context.user.avatarUrl,
        roleLabel,
      }}
      sections={[...visibleAdminSections(context.actor)]}
      events={context.events}
      activeEventId={context.eventId}
    >
      {children}
    </AdminShell>
  );
}
