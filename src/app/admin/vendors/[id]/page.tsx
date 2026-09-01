import type { Metadata } from "next";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/admin/PageHeader";
import { StatusChanger } from "@/components/admin/StatusChanger";
import { APPLICATION_STATUS_META, Pill, StatusPill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { IconChevronLeft } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { vendorApplications } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { formatDateTime } from "@/lib/format";
import { VENDOR_ASSORTMENT_LABELS, VENDOR_STAND_TYPE_LABELS } from "@/lib/labels";
import { isAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "Detail stánku" };

export default async function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getAdminContext();
  if (!context) return null;

  const { id } = await params;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(vendorApplications)
    .where(and(eq(vendorApplications.id, id), eq(vendorApplications.eventId, context.eventId)))
    .limit(1);

  if (!row) notFound();

  const utilities = [
    { label: "Elektrina", value: row.needsElectricity, detail: row.powerKw ? `${row.powerKw} kW` : null },
    { label: "Voda", value: row.needsWater, detail: null },
    { label: "Odpad", value: row.needsWaste, detail: null },
  ];

  return (
    <>
      <Link
        href="/admin/vendors"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na stánkarov
      </Link>

      <PageHeader
        title={row.companyName || row.contactName}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={row.status} meta={APPLICATION_STATUS_META} />
            <span>
              {VENDOR_STAND_TYPE_LABELS[row.standType as keyof typeof VENDOR_STAND_TYPE_LABELS] ??
                row.standType}
              {row.widthM && row.depthM ? ` · ${row.widthM} × ${row.depthM} m` : ""}
            </span>
          </span>
        }
      />

      {isAdmin(context.actor) || context.actor.eventRole === "admin" ? (
        <Card className="mb-5 p-5">
          <h2 className="eyebrow mb-3.5 text-muted">Rozhodnutie</h2>
          <StatusChanger id={id} kind="vendor" current={row.status} />
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <div className="flex min-w-0 flex-col gap-5">
          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-4 text-muted">Kontakt</h2>
            <dl className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Kontaktná osoba" value={row.contactName} />
              <Field label="IČO" value={row.ico ?? "—"} />
              <Field label="E-mail" value={row.email} href={`mailto:${row.email}`} />
              <Field label="Telefón" value={row.phone} href={`tel:${row.phone}`} />
              {row.website ? <Field label="Web" value={row.website} href={row.website} /> : null}
              {row.instagram ? <Field label="Instagram" value={row.instagram} /> : null}
              {row.facebook ? <Field label="Facebook" value={row.facebook} /> : null}
              <Field
                label="Prihlásená"
                value={formatDateTime(row.createdAt, context.event.timezone)}
              />
            </dl>
          </Card>

          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-3.5 text-muted">Sortiment</h2>
            <div className="flex flex-wrap gap-2">
              {row.assortment.map((key) => (
                <Pill key={key}>
                  {VENDOR_ASSORTMENT_LABELS[key as keyof typeof VENDOR_ASSORTMENT_LABELS] ?? key}
                </Pill>
              ))}
            </div>
            {row.assortmentDetail ? (
              <p className="mt-4 text-[15px] leading-[1.6] text-body">{row.assortmentDetail}</p>
            ) : null}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Card className="p-5 sm:p-6">
            <h2 className="eyebrow mb-3.5 text-muted">Technické požiadavky</h2>
            <ul className="flex flex-col divide-y divide-divider">
              {utilities.map((utility) => (
                <li key={utility.label} className="flex items-center justify-between gap-3 py-3">
                  <span className="text-[15px]">{utility.label}</span>
                  <span className="flex items-center gap-2">
                    {utility.detail ? (
                      <span className="nums text-sm text-muted">{utility.detail}</span>
                    ) : null}
                    <Pill kind={utility.value ? "ok" : "neutral"}>
                      {utility.value ? "Áno" : "Nie"}
                    </Pill>
                  </span>
                </li>
              ))}
            </ul>
            {row.placementRequest ? (
              <div className="mt-4">
                <p className="text-[13px] text-faint">Požiadavky na miesto</p>
                <p className="mt-1 text-[15px] leading-[1.6] text-body">{row.placementRequest}</p>
              </div>
            ) : null}
          </Card>

          {row.attachments.length > 0 ? (
            <Card className="p-5 sm:p-6">
              <h2 className="eyebrow mb-3.5 text-muted">Prílohy</h2>
              <ul className="flex flex-col gap-2">
                {row.attachments.map((attachment) => (
                  <li key={attachment.url}>
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[15px] font-medium underline underline-offset-4 hover:text-muted"
                    >
                      {attachment.name}
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {row.note ? (
            <Card className="p-5 sm:p-6">
              <h2 className="eyebrow mb-3 text-muted">Poznámka</h2>
              <p className="text-[15px] leading-[1.6] text-body">{row.note}</p>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Field({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div>
      <dt className="text-[13px] text-faint">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-medium break-words">
        {href ? (
          <a
            href={href}
            target={href.startsWith("http") ? "_blank" : undefined}
            rel={href.startsWith("http") ? "noopener noreferrer" : undefined}
            className="underline underline-offset-4 hover:text-muted"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
