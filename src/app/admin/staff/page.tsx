import type { Metadata } from "next";

import { PageHeader } from "@/components/admin/PageHeader";
import { StaffTable } from "@/components/admin/StaffTable";
import { Card } from "@/components/ui/Card";
import { FilterBar, FilterSelect, Pagination, SearchInput, SortSelect } from "@/components/ui/Filters";
import { EVENT_ROLES, USER_STATUSES, type EventRole, type UserStatus } from "@/db/enums";
import { getAdminContext } from "@/lib/admin-context";
import { listPositions } from "@/lib/domain/shifts";
import { countStaffByRole, listStaff } from "@/lib/domain/staff";
import { EVENT_ROLE_LABELS } from "@/lib/labels";

export const metadata: Metadata = { title: "Crew" };

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const roleParam = one(params.role);
  const statusParam = one(params.status);

  const [result, roleCounts, positionRows] = await Promise.all([
    listStaff(context.eventId, {
      q: one(params.q),
      role: EVENT_ROLES.includes(roleParam as EventRole) ? (roleParam as EventRole) : undefined,
      status: USER_STATUSES.includes(statusParam as UserStatus)
        ? (statusParam as UserStatus)
        : undefined,
      positionId: one(params.position),
      minScore: one(params.minScore) ? Number(one(params.minScore)) : undefined,
      sort: one(params.sort) as "name" | "score" | "hours" | "shifts" | undefined,
      page: Number(one(params.page) ?? 1),
    }),
    countStaffByRole(context.eventId),
    listPositions(context.eventId),
  ]);

  const activeFilterCount = [
    params.role,
    params.status,
    params.position,
    params.minScore,
    params.sort,
  ].filter(Boolean).length;

  return (
    <>
      <PageHeader
        title="Crew"
        subtitle={`${result.total} ľudí · ${roleCounts.coordinator ?? 0} koordinátorov · ${roleCounts.admin ?? 0} adminov`}
      />

      <div className="mb-5 flex flex-wrap items-end gap-3">
        <SearchInput
          placeholder="Hľadať meno, e-mail, telefón, mesto…"
          className="min-w-0 flex-1 lg:max-w-[360px]"
        />
        <FilterBar activeCount={activeFilterCount}>
          <FilterSelect
            paramName="role"
            label="Rola"
            allLabel="Všetky role"
            options={EVENT_ROLES.map((role) => ({ value: role, label: EVENT_ROLE_LABELS[role] }))}
          />
          <FilterSelect
            paramName="status"
            label="Stav účtu"
            allLabel="Všetky"
            options={[
              { value: "active", label: "Aktívny" },
              { value: "suspended", label: "Deaktivovaný" },
              { value: "pending", label: "Čaká" },
            ]}
          />
          <FilterSelect
            paramName="position"
            label="Pozícia"
            allLabel="Všetky pozície"
            options={positionRows.map((position) => ({ value: position.id, label: position.name }))}
          />
          <FilterSelect
            paramName="minScore"
            label="Minimálne skóre"
            allLabel="Akékoľvek"
            options={[
              { value: "50", label: "50 a viac" },
              { value: "70", label: "70 a viac" },
              { value: "85", label: "85 a viac" },
            ]}
          />
          <SortSelect
            options={[
              { value: "name", label: "Podľa priezviska" },
              { value: "score", label: "Podľa skóre" },
              { value: "hours", label: "Podľa hodín" },
              { value: "shifts", label: "Podľa počtu smien" },
            ]}
          />
        </FilterBar>
      </div>

      <Card className="overflow-hidden">
        <StaffTable
          rows={result.rows.map((row) => ({
            userId: row.userId,
            firstName: row.firstName,
            lastName: row.lastName,
            email: row.email,
            city: row.city,
            avatarUrl: row.avatarUrl,
            status: row.status,
            role: row.role,
            score: Number(row.score),
            shiftCount: Number(row.shiftCount),
            minutes: Number(row.minutes),
            noShows: Number(row.noShows),
          }))}
        />
        <div className="border-t border-line">
          <Pagination
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            pageSize={result.pageSize}
          />
        </div>
      </Card>
    </>
  );
}
