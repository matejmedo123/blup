import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";

import { CrewScoreRing } from "@/components/admin/CrewScoreRing";
import { PageHeader } from "@/components/admin/PageHeader";
import { ManualScoreButton, ScoreRulesForm } from "@/components/admin/ScoreRulesForm";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Badge";
import { Card, Kpi } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconChart } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { crewScores, scoreTransactions, users } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { ensureScoreRules, getScoreRules } from "@/lib/domain/score";
import { listStaff } from "@/lib/domain/staff";
import { formatDateTime } from "@/lib/format";
import { isAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "Crew Score" };

export default async function ScorePage() {
  const context = await getAdminContext();
  if (!context) return null;

  const tz = context.event.timezone;
  const canManage = isAdmin(context.actor) || context.actor.eventRole === "admin";

  await ensureScoreRules(context.eventId);
  const db = await getDb();

  const [rules, leaderboard, recent, staff, [stats]] = await Promise.all([
    getScoreRules(context.eventId),
    db
      .select({
        userId: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarUrl: users.avatarUrl,
        score: crewScores.score,
      })
      .from(crewScores)
      .innerJoin(users, eq(users.id, crewScores.userId))
      .where(eq(crewScores.eventId, context.eventId))
      .orderBy(desc(crewScores.score))
      .limit(10),
    db
      .select({
        id: scoreTransactions.id,
        delta: scoreTransactions.delta,
        reason: scoreTransactions.reason,
        ruleKey: scoreTransactions.ruleKey,
        createdAt: scoreTransactions.createdAt,
        userId: scoreTransactions.userId,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(scoreTransactions)
      .innerJoin(users, eq(users.id, scoreTransactions.userId))
      .where(eq(scoreTransactions.eventId, context.eventId))
      .orderBy(desc(scoreTransactions.createdAt))
      .limit(30),
    listStaff(context.eventId, { pageSize: 500 }),
    db
      .select({
        average: sql<string>`coalesce(avg(${crewScores.score}), 0)`,
        below: sql<number>`count(*) filter (where ${crewScores.score} < 60)::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(crewScores)
      .where(eq(crewScores.eventId, context.eventId)),
  ]);

  const average = Math.round(Number(stats?.average ?? 0));

  return (
    <>
      <PageHeader
        title="Crew Score"
        subtitle="Konfigurovateľné pravidlá bodovania a prehľad skóre celej crew."
        action={
          canManage ? (
            <ManualScoreButton
              staff={staff.rows.map((row) => ({
                id: row.userId,
                name: `${row.firstName} ${row.lastName}`,
              }))}
            />
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Kpi tone="dark" label="Priemerné skóre" value={average} note={`${stats?.total ?? 0} ľudí`} />
        <Kpi
          tone={(stats?.below ?? 0) > 0 ? "accent" : "plain"}
          label="Pod 60 bodov"
          value={stats?.below ?? 0}
          note="stojí za pozretie"
        />
        <Kpi label="Aktívnych pravidiel" value={rules.filter((r) => r.active).length} note={`z ${rules.length}`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_1fr] xl:items-start">
        <Card className="p-5 sm:p-6">
          <h2 className="section-label mb-4">Pravidlá bodovania</h2>
          {canManage ? (
            <ScoreRulesForm
              rules={rules.map((rule) => ({
                key: rule.key,
                label: rule.label,
                delta: rule.delta,
                active: rule.active,
              }))}
            />
          ) : (
            <ul className="flex flex-col divide-y divide-divider">
              {rules.map((rule) => (
                <li key={rule.id} className="flex items-center justify-between gap-3 py-3">
                  <span className="text-[15px]">{rule.label}</span>
                  <Pill kind={rule.delta >= 0 ? "ok" : "bad"}>
                    {rule.delta > 0 ? `+${rule.delta}` : rule.delta}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card className="p-5 sm:p-6">
            <h2 className="section-label mb-4">Najlepšia crew</h2>
            {leaderboard.length === 0 ? (
              <EmptyState
                icon={<IconChart width={26} height={26} />}
                title="Zatiaľ žiadne skóre"
                description="Skóre vzniká po prvej odpracovanej smene."
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {leaderboard.map((row, index) => (
                  <li key={row.userId}>
                    <Link
                      href={`/admin/staff/${row.userId}`}
                      className="flex items-center gap-3 rounded-10 p-1 transition-colors hover:bg-hover"
                    >
                      <span className="nums w-5 shrink-0 text-[13px] font-bold text-faint">
                        {index + 1}
                      </span>
                      <Avatar
                        firstName={row.firstName}
                        lastName={row.lastName}
                        src={row.avatarUrl}
                        size="xs"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {row.firstName} {row.lastName}
                      </span>
                      {index === 0 ? (
                        <CrewScoreRing score={row.score} size={44} />
                      ) : (
                        <span className="nums text-[15px] font-bold">{row.score}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5 sm:p-6">
            <h2 className="section-label mb-4">Posledné zmeny</h2>
            {recent.length === 0 ? (
              <p className="text-[15px] text-muted">Zatiaľ žiadna zmena skóre.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-divider">
                {recent.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {row.firstName} {row.lastName}
                      </p>
                      <p className="truncate text-[13px] text-faint">
                        {row.reason ?? row.ruleKey} · {formatDateTime(row.createdAt, tz)}
                      </p>
                    </div>
                    <Pill kind={row.delta >= 0 ? "ok" : "bad"}>
                      {row.delta > 0 ? `+${row.delta}` : row.delta}
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
