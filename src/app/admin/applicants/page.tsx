import type { Metadata } from "next";
import { Suspense } from "react";

import { ApplicantsTable } from "@/components/admin/ApplicantsTable";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatusFilterPills } from "@/components/admin/StatusFilterPills";
import { Card } from "@/components/ui/Card";
import { FilterBar, FilterSelect, Pagination, SearchInput, SortSelect } from "@/components/ui/Filters";
import { SkeletonList } from "@/components/ui/States";
import { APPLICATION_STATUSES, POSITION_KEYS, type ApplicationStatus } from "@/db/enums";
import { getAdminContext } from "@/lib/admin-context";
import { countApplicantsByStatus, listApplicants } from "@/lib/domain/applications";
import { POSITION_KEY_LABELS } from "@/lib/labels";
import { isAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "Prihlášky" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ApplicantsPage({ searchParams }: { searchParams: SearchParams }) {
  const context = await getAdminContext();
  if (!context) return null;

  const params = await searchParams;
  const statusParam = single(params.status);
  const status = APPLICATION_STATUSES.includes(statusParam as ApplicationStatus)
    ? (statusParam as ApplicationStatus)
    : undefined;

  const [counts, result] = await Promise.all([
    countApplicantsByStatus(context.eventId),
    listApplicants(context.eventId, {
      q: single(params.q),
      status,
      position: single(params.position),
      city: single(params.city),
      minScore: single(params.minScore) ? Number(single(params.minScore)) : undefined,
      sort: single(params.sort) as "newest" | "oldest" | "name" | "score" | undefined,
      page: Number(single(params.page) ?? 1),
    }),
  ]);

  const pending = counts.pending ?? 0;
  const reviewing = counts.reviewing ?? 0;
  const activeFilterCount = [params.position, params.city, params.minScore, params.sort].filter(
    Boolean,
  ).length;

  return (
    <>
      <PageHeader
        title="Prihlášky"
        subtitle={
          pending + reviewing > 0
            ? `${pending + reviewing} čaká na posúdenie · ${counts.approved ?? 0} schválených`
            : `${result.total} prihlášok celkom`
        }
      />

      <div className="mb-5 flex flex-col gap-3">
        <StatusFilterPills
          counts={counts}
          total={Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0)}
        />
        <div className="flex flex-wrap items-end gap-3">
          <SearchInput placeholder="Hľadať meno, e-mail, mesto…" className="min-w-0 flex-1 lg:max-w-[360px]" />
          <FilterBar activeCount={activeFilterCount}>
            <FilterSelect
              paramName="position"
              label="Pozícia"
              allLabel="Všetky pozície"
              options={POSITION_KEYS.map((key) => ({ value: key, label: POSITION_KEY_LABELS[key] }))}
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
                { value: "newest", label: "Najnovšie" },
                { value: "oldest", label: "Najstaršie" },
                { value: "name", label: "Podľa priezviska" },
                { value: "score", label: "Podľa skóre" },
              ]}
            />
          </FilterBar>
        </div>
      </div>

      <Card className="overflow-hidden">
        <Suspense fallback={<SkeletonList rows={6} />}>
          <ApplicantsTable
            canDecide={isAdmin(context.actor) || context.actor.eventRole === "admin"}
            rows={result.rows.map((row) => ({
              applicationId: row.applicationId,
              userId: row.userId,
              firstName: row.firstName,
              lastName: row.lastName,
              email: row.email,
              city: row.city,
              birthYear: row.birthYear,
              avatarUrl: row.avatarUrl,
              status: row.status,
              createdAt: row.createdAt.toISOString(),
              score: row.score,
              experienceCount: row.experienceCount,
              positions: row.positions,
            }))}
          />
        </Suspense>
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
