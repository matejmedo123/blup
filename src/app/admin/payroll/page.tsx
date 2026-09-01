import type { Metadata } from "next";

import { PageHeader } from "@/components/admin/PageHeader";
import { PayrollTable } from "@/components/admin/PayrollTable";
import { ButtonLink } from "@/components/ui/Button";
import { Card, Kpi } from "@/components/ui/Card";
import { EmptyState, InlineNotice } from "@/components/ui/States";
import { IconDownload, IconEuro } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { eventSettings } from "@/lib/domain/events";
import { payrollLines, round2, summarisePayroll } from "@/lib/domain/payroll";
import { formatMoney } from "@/lib/format";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Výplaty" };

export default async function PayrollPage() {
  const context = await getAdminContext();
  if (!context) return null;

  if (!can(context.actor, "can_view_payroll")) {
    return (
      <Card>
        <EmptyState
          icon={<IconEuro width={26} height={26} />}
          title="Nemáš prístup k mzdám"
          description="Mzdové podklady vidí len admin alebo koordinátor s právom „Prístup k mzdám“."
        />
      </Card>
    );
  }

  const currency = eventSettings(context.event).currency;
  const allLines = await payrollLines(context.eventId, { onlyApproved: false });
  const approvedLines = allLines.filter((line) => line.approved);
  const pendingLines = allLines.filter((line) => !line.approved);

  const summaries = summarisePayroll(allLines);
  const totalAll = round2(allLines.reduce((sum, line) => sum + line.earnings.total, 0));
  const totalApproved = round2(approvedLines.reduce((sum, line) => sum + line.earnings.total, 0));
  const totalPending = round2(pendingLines.reduce((sum, line) => sum + line.earnings.total, 0));
  const totalHours = round2(allLines.reduce((sum, line) => sum + line.earnings.hours, 0));
  const people = new Set(allLines.map((line) => line.userId)).size;
  const approvedPeople = new Set(approvedLines.map((line) => line.userId)).size;

  return (
    <>
      <PageHeader
        title="Výplaty"
        subtitle={`${context.event.name} · uzávierka po skončení eventu`}
        action={
          <>
            <ButtonLink
              href="/api/exports/payroll.csv"
              variant="outline"
              size="sm"
              icon={<IconDownload width={18} height={18} />}
            >
              Export CSV
            </ButtonLink>
            <ButtonLink href="/admin/exports" size="sm">
              Exporty
            </ButtonLink>
          </>
        }
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-[1.1fr_1fr_1fr]">
        <Kpi
          tone="dark"
          label="Na vyplatenie"
          value={formatMoney(totalAll, currency)}
          note={`${people} ${people === 1 ? "človek" : "ľudí"} · ${totalHours} hodín`}
        />
        <Kpi
          label="Schválené"
          value={formatMoney(totalApproved, currency)}
          note={`${approvedPeople} ${approvedPeople === 1 ? "človek" : "ľudí"}`}
        />
        <Kpi
          label="Čaká na schválenie"
          value={formatMoney(totalPending, currency)}
          note={`${pendingLines.length} ${pendingLines.length === 1 ? "riadok" : "riadkov"} dochádzky`}
        />
      </div>

      {pendingLines.length > 0 ? (
        <div className="mb-5">
          <InlineNotice tone="warning" title="Časť dochádzky ešte nie je schválená">
            Export a výplata rátajú iba so schválenými hodinami. Schváľ ich v sekcii{" "}
            <a href="/admin/attendance" className="font-semibold underline underline-offset-4">
              Dochádzka
            </a>
            .
          </InlineNotice>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {summaries.length === 0 ? (
          <EmptyState
            icon={<IconEuro width={26} height={26} />}
            title="Zatiaľ žiadne mzdové podklady"
            description="Podklady vznikajú automaticky z odpracovaných smien. Po prvom check-oute sa objavia tu."
          />
        ) : (
          <PayrollTable
            currency={currency}
            rows={summaries.map((row) => ({
              userId: row.userId,
              name: `${row.firstName} ${row.lastName}`,
              email: row.email,
              positionName: row.positionName,
              hours: row.hours,
              hourlyRate: row.hourlyRate,
              gross: row.gross,
              bonus: row.bonus,
              adjustments: row.adjustments,
              total: row.total,
              allApproved: row.allApproved,
            }))}
          />
        )}
      </Card>

      <p className="mt-4 text-[13px] leading-[1.5] text-muted">
        Sumy vychádzajú z dochádzky. Každá oprava dochádzky zruší schválenie a riadok sa musí
        schváliť znova — mzdový podklad tak vždy zodpovedá reálne odpracovanému času.
      </p>
    </>
  );
}
