import type { Metadata } from "next";
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";

import { PageHeader } from "@/components/admin/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { FilterSelect, Pagination, SearchInput } from "@/components/ui/Filters";
import { EmptyState } from "@/components/ui/States";
import { IconClipboard } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { auditLogs, users } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { AUDIT_ACTION_LABELS } from "@/lib/audit";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

/** Zobrazí diff v čitateľnej podobe — nie surový JSON. */
function renderDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string | null {
  if (!after) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    const previous = before?.[key];
    const format = (v: unknown) =>
      v == null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(previous !== undefined ? `${key}: ${format(previous)} → ${format(value)}` : `${key}: ${format(value)}`);
  }
  return parts.slice(0, 6).join(" · ");
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const q = one(params.q);
  const entity = one(params.entity);
  const page = Math.max(1, Number(one(params.page) ?? 1));

  const db = await getDb();
  const conditions: SQL[] = [eq(auditLogs.eventId, context.eventId)];
  if (entity) conditions.push(eq(auditLogs.entity, entity));
  if (q) {
    const like = `%${q}%`;
    const search = or(
      ilike(auditLogs.action, like),
      ilike(auditLogs.entity, like),
      ilike(users.firstName, like),
      ilike(users.lastName, like),
    );
    if (search) conditions.push(search);
  }
  const where = and(...conditions);

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entity: auditLogs.entity,
      entityId: auditLogs.entityId,
      beforeValue: auditLogs.beforeValue,
      afterValue: auditLogs.afterValue,
      ip: auditLogs.ip,
      createdAt: auditLogs.createdAt,
      actorId: auditLogs.actorId,
      actorFirstName: users.firstName,
      actorLastName: users.lastName,
      actorAvatar: users.avatarUrl,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE);

  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  const tz = context.event.timezone;

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Každá dôležitá akcia — kto, čo, kedy a s akou zmenou. Záznamy sa nedajú meniť ani mazať."
      />

      <div className="mb-5 flex flex-wrap items-end gap-3">
        <SearchInput placeholder="Hľadať akciu alebo meno…" className="min-w-0 flex-1 lg:max-w-[360px]" />
        <FilterSelect
          paramName="entity"
          label="Entita"
          allLabel="Všetko"
          options={[
            { value: "application", label: "Prihlášky" },
            { value: "user", label: "Používatelia" },
            { value: "shift", label: "Smeny" },
            { value: "attendance", label: "Dochádzka" },
            { value: "position", label: "Pozície" },
            { value: "conversation", label: "Správy" },
            { value: "incident", label: "Incidenty" },
            { value: "event", label: "Event a mzdy" },
          ]}
        />
      </div>

      <Card className="overflow-hidden">
        {visible.length === 0 ? (
          <EmptyState
            icon={<IconClipboard width={26} height={26} />}
            title="Žiadne záznamy"
            description="Pre zvolené filtre sme nič nenašli. Skús zmeniť entitu alebo vymazať hľadanie."
          />
        ) : (
          <ul className="divide-y divide-divider">
            {visible.map((row) => {
              const diff = renderDiff(row.beforeValue, row.afterValue);
              return (
                <li key={row.id} className="flex flex-wrap items-start gap-3 p-4">
                  {row.actorFirstName ? (
                    <Avatar
                      firstName={row.actorFirstName}
                      lastName={row.actorLastName ?? ""}
                      src={row.actorAvatar}
                      size="xs"
                    />
                  ) : (
                    <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-subtle text-[11px] font-bold text-muted">
                      SYS
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-semibold">
                      {AUDIT_ACTION_LABELS[row.action] ?? row.action}
                    </p>
                    <p className="text-[13px] text-muted">
                      {row.actorFirstName
                        ? `${row.actorFirstName} ${row.actorLastName}`
                        : "Systém"}{" "}
                      · {formatDateTime(row.createdAt, tz)}
                      {row.ip ? ` · ${row.ip}` : ""}
                    </p>
                    {diff ? (
                      <p className="mt-1.5 font-mono text-[12px] break-words text-body">{diff}</p>
                    ) : null}
                  </div>

                  <Pill>{row.entity}</Pill>
                </li>
              );
            })}
          </ul>
        )}
        <div className="border-t border-line">
          <Pagination
            page={page}
            pageCount={hasMore ? page + 1 : page}
            total={(page - 1) * PAGE_SIZE + visible.length}
            pageSize={PAGE_SIZE}
          />
        </div>
      </Card>
    </>
  );
}
