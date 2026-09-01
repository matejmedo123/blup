import type { Metadata } from "next";
import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";

import { PageHeader } from "@/components/admin/PageHeader";
import { SimpleStatusTable } from "@/components/admin/SimpleStatusTable";
import { StatusFilterPills } from "@/components/admin/StatusFilterPills";
import { Card } from "@/components/ui/Card";
import { Pagination, SearchInput } from "@/components/ui/Filters";
import { getDb } from "@/db/client";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/db/enums";
import { volunteerApplications } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { VOLUNTEER_PREFERENCE_LABELS } from "@/lib/labels";
import { isAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "Dobrovoľníci" };

const PAGE_SIZE = 25;

export default async function VolunteersPage({
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
  const conditions: SQL[] = [eq(volunteerApplications.eventId, context.eventId)];
  if (status) conditions.push(eq(volunteerApplications.status, status));
  if (q) {
    const like = `%${q}%`;
    const search = or(
      ilike(volunteerApplications.firstName, like),
      ilike(volunteerApplications.lastName, like),
      ilike(volunteerApplications.email, like),
      ilike(volunteerApplications.phone, like),
      ilike(volunteerApplications.city, like),
      sql`lower(${volunteerApplications.firstName} || ' ' || ${volunteerApplications.lastName}) like lower(${like})`,
    );
    if (search) conditions.push(search);
  }
  const where = and(...conditions);

  const [rows, [{ value: total }], statusCounts] = await Promise.all([
    db
      .select()
      .from(volunteerApplications)
      .where(where)
      .orderBy(desc(volunteerApplications.createdAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ value: count() }).from(volunteerApplications).where(where),
    db
      .select({ status: volunteerApplications.status, value: count() })
      .from(volunteerApplications)
      .where(eq(volunteerApplications.eventId, context.eventId))
      .groupBy(volunteerApplications.status),
  ]);

  const counts = Object.fromEntries(statusCounts.map((r) => [r.status, Number(r.value)])) as Partial<
    Record<ApplicationStatus, number>
  >;

  return (
    <>
      <PageHeader
        title="Dobrovoľníci"
        subtitle={`${Number(total)} prihlášok · ${counts.pending ?? 0} čaká na posúdenie`}
      />

      <div className="mb-5 flex flex-col gap-3">
        <StatusFilterPills
          counts={counts}
          total={Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0)}
        />
        <SearchInput placeholder="Hľadať meno, e-mail, mesto…" className="lg:max-w-[360px]" />
      </div>

      <Card className="overflow-hidden">
        <SimpleStatusTable
          kind="volunteer"
          canDecide={isAdmin(context.actor) || context.actor.eventRole === "admin"}
          rows={rows.map((row) => ({
            id: row.id,
            title: `${row.firstName} ${row.lastName}`,
            subtitle: [row.city, row.birthYear].filter(Boolean).join(" · ") || "—",
            meta: row.preferences
              .map(
                (p) =>
                  VOLUNTEER_PREFERENCE_LABELS[p as keyof typeof VOLUNTEER_PREFERENCE_LABELS] ?? p,
              )
              .join(", "),
            contact: `${row.email} · ${row.phone}`,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            tags: row.preferences.map(
              (p) => VOLUNTEER_PREFERENCE_LABELS[p as keyof typeof VOLUNTEER_PREFERENCE_LABELS] ?? p,
            ),
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
