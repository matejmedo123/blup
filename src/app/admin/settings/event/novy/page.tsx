import type { Metadata } from "next";
import Link from "next/link";

import { NewEventForm } from "@/components/admin/NewEventForm";
import { PageHeader } from "@/components/admin/PageHeader";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconChevronLeft } from "@/components/ui/Icons";
import { requireFullAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Nový event" };

export default async function NewEventPage() {
  const session = await requireFullAdmin();
  if (!session) {
    return (
      <Card>
        <EmptyState title="Prístup majú len admini" />
      </Card>
    );
  }

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
        title="Nový event"
        subtitle="Každý event má vlastnú crew, pozície, smeny, dochádzku aj mzdy."
      />

      <Card className="max-w-[620px] p-5 sm:p-7">
        <NewEventForm />
      </Card>
    </>
  );
}
