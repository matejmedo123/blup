import type { Metadata } from "next";
import { and, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";

import { PageHeader } from "@/components/admin/PageHeader";
import { SimpleStatusTable } from "@/components/admin/SimpleStatusTable";
import { StatusFilterPills } from "@/components/admin/StatusFilterPills";
import { Card } from "@/components/ui/Card";
import { Pagination, SearchInput } from "@/components/ui/Filters";
import { getDb } from "@/db/client";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/db/enums";
import { vendorApplications } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { VENDOR_ASSORTMENT_LABELS, VENDOR_STAND_TYPE_LABELS } from "@/lib/labels";
import { isAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "Stánkari" };

const PAGE_SIZE = 25;

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const statusParam = one(params.status);
  const status = APPLICATION_STATUSES.includes(statusParam as ApplicationStatus)
    ? (statusParam as ApplicationStatus)
    : undefined;
  const q = one(params.q);
  const page = Math.max(1, Number(one(params.page) ?? 1));

  const db = await getDb();
  const conditions: SQL[] = [eq(vendorApplications.eventId, context.eventId)];
  if (status) conditions.push(eq(vendorApplications.status, status));
  if (q) {
    const like = `%${q}%`;
    const search = or(
      ilike(vendorApplications.contactName, like),
      ilike(vendorApplications.companyName, like),
      ilike(vendorApplications.email, like),
      ilike(vendorApplications.phone, like),
      ilike(vendorApplications.ico, like),
    );
    if (search) conditions.push(search);
  }
  const where = and(...conditions);

  const [rows, [{ value: total }], statusCounts] = await Promise.all([
    db
      .select()
      .from(vendorApplications)
      .where(where)
      .orderBy(desc(vendorApplications.createdAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ value: count() }).from(vendorApplications).where(where),
    db
      .select({ status: vendorApplications.status, value: count() })
      .from(vendorApplications)
      .where(eq(vendorApplications.eventId, context.eventId))
      .groupBy(vendorApplications.status),
  ]);

  const counts = Object.fromEntries(statusCounts.map((r) => [r.status, Number(r.value)])) as Partial<
    Record<ApplicationStatus, number>
  >;

  return (
    <>
      <PageHeader
        title="Stánkari"
        subtitle={`${Number(total)} prihlášok · ${counts.pending ?? 0} čaká na posúdenie`}
      />

      <div className="mb-5 flex flex-col gap-3">
        <StatusFilterPills
          counts={counts}
          total={Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0)}
        />
        <SearchInput placeholder="Hľadať názov, IČO, e-mail…" className="lg:max-w-[360px]" />
      </div>

      <Card className="overflow-hidden">
        <SimpleStatusTable
          kind="vendor"
          canDecide={isAdmin(context.actor) || context.actor.eventRole === "admin"}
          rows={rows.map((row) => ({
            id: row.id,
            title: row.companyName || row.contactName,
            subtitle: [
              VENDOR_STAND_TYPE_LABELS[row.standType as keyof typeof VENDOR_STAND_TYPE_LABELS] ??
                row.standType,
              row.widthM && row.depthM ? `${row.widthM} × ${row.depthM} m` : null,
            ]
              .filter(Boolean)
              .join(" · "),
            meta: row.assortment
              .map(
                (a) => VENDOR_ASSORTMENT_LABELS[a as keyof typeof VENDOR_ASSORTMENT_LABELS] ?? a,
              )
              .join(", "),
            contact: `${row.email} · ${row.phone}`,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            tags: [
              row.needsElectricity ? "Elektrina" : null,
              row.needsWater ? "Voda" : null,
              row.needsWaste ? "Odpad" : null,
            ].filter(Boolean) as string[],
          }))}
        />
        <div className="border-t border-line">
          <Pagination
            page={page}
            pageCount={Math.max(1, Math.ceil(Number(total) / PAGE_SIZE))}
            total={Number(total)}
            pageSize={PAGE_SIZE}
          />
        </div>
      </Card>
    </>
  );
}
