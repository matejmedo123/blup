import type { Metadata } from "next";
import Link from "next/link";

import { EventSettingsForm } from "@/components/admin/EventSettingsForm";
import { PageHeader } from "@/components/admin/PageHeader";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconSettings } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { eventSettings } from "@/lib/domain/events";
import { isAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "Nastavenia eventu" };

export default async function SettingsPage() {
  const context = await getAdminContext();
  if (!context) return null;

  if (!isAdmin(context.actor) && context.actor.eventRole !== "admin") {
    return (
      <Card>
        <EmptyState
          icon={<IconSettings width={26} height={26} />}
          title="Nastavenia sú len pre adminov"
          description="Zmeny eventu, používateľov a oprávnení môže robiť iba admin eventu."
        />
      </Card>
    );
  }

  const settings = eventSettings(context.event);

  return (
    <>
      <PageHeader
        title="Nastavenia eventu"
        subtitle={`${context.event.name} · ${context.event.slug}`}
        action={
          <ButtonLink href="/admin/settings/event/novy" variant="outline" size="sm">
            Nový event
          </ButtonLink>
        }
      />

      <div className="mb-5 flex flex-wrap gap-2.5">
        {[
          { href: "/admin/settings/users", label: "Používatelia" },
          { href: "/admin/settings/permissions", label: "Oprávnenia" },
          { href: "/admin/settings/audit", label: "Audit log" },
        ].map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="touch inline-flex items-center rounded-12 border border-line-strong bg-surface px-4 text-[13px] font-semibold hover:bg-hover"
          >
            {link.label}
          </Link>
        ))}
      </div>

      <Card className="max-w-[820px] p-5 sm:p-7">
        <EventSettingsForm
          initial={{
            name: context.event.name,
            description: context.event.description ?? "",
            location: context.event.location ?? "",
            lat: context.event.lat ?? "",
            lng: context.event.lng ?? "",
            startDate: context.event.startDate,
            endDate: context.event.endDate,
            timezone: context.event.timezone,
            status: context.event.status,
            currency: settings.currency,
            rounding: settings.rounding,
            overtimeAfterHours: String(settings.overtime_after_hours),
            overtimeMultiplier: String(settings.overtime_multiplier),
            defaultGeofenceRadiusM: String(settings.default_geofence_radius_m),
            reminderHoursBefore: String(settings.reminder_hours_before),
          }}
        />
      </Card>
    </>
  );
}
