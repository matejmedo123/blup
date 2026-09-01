import type { Metadata } from "next";

import { GeneratePayrollButton } from "@/components/admin/GeneratePayrollButton";
import { PageHeader } from "@/components/admin/PageHeader";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, InlineNotice } from "@/components/ui/States";
import { IconDownload, IconEuro } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { payrollLines } from "@/lib/domain/payroll";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Exporty" };

export default async function ExportsPage() {
  const context = await getAdminContext();
  if (!context) return null;

  if (!can(context.actor, "can_view_payroll")) {
    return (
      <Card>
        <EmptyState
          icon={<IconEuro width={26} height={26} />}
          title="Nemáš prístup k exportom"
          description="Exporty miezd vidí len admin alebo koordinátor s právom „Prístup k mzdám“."
        />
      </Card>
    );
  }

  const [approved, all] = await Promise.all([
    payrollLines(context.eventId, { onlyApproved: true }),
    payrollLines(context.eventId, { onlyApproved: false }),
  ]);

  return (
    <>
      <PageHeader
        title="Exporty"
        subtitle="Mzdové podklady na stiahnutie. CSV je oddelené bodkočiarkou a v UTF-8 s BOM — otvorí sa v slovenskom Exceli správne."
      />

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <Card className="p-5 sm:p-6">
          <h2 className="text-[19px] font-bold tracking-[-0.02em]">Mzdy — schválené</h2>
          <p className="mt-2 text-[15px] leading-[1.6] text-muted">
            {approved.length} riadkov zo schválenej dochádzky. Toto je export, ktorý ide do
            účtovníctva.
          </p>
          <ButtonLink
            href="/api/exports/payroll.csv"
            className="mt-4"
            icon={<IconDownload width={18} height={18} />}
          >
            Stiahnuť CSV
          </ButtonLink>
        </Card>

        <Card className="p-5 sm:p-6">
          <h2 className="text-[19px] font-bold tracking-[-0.02em]">Mzdy — všetko vrátane čakajúcich</h2>
          <p className="mt-2 text-[15px] leading-[1.6] text-muted">
            {all.length} riadkov vrátane neschválenej dochádzky. Riadky nesú stĺpec{" "}
            <code className="font-mono text-[13px]">approved</code> — použi ho na kontrolu, nie na
            výplatu.
          </p>
          <ButtonLink
            href="/api/exports/payroll.csv?all=1"
            variant="outline"
            className="mt-4"
            icon={<IconDownload width={18} height={18} />}
          >
            Stiahnuť kontrolné CSV
          </ButtonLink>
        </Card>
      </div>

      <Card className="mt-5 p-5 sm:p-6">
        <h2 className="text-[19px] font-bold tracking-[-0.02em]">Mzdové záznamy</h2>
        <p className="mt-2 mb-4 text-[15px] leading-[1.6] text-muted">
          Vygeneruje trvalé mzdové záznamy zo schválenej dochádzky. Opakované spustenie existujúce
          záznamy aktualizuje, nevytvára duplicity.
        </p>
        <GeneratePayrollButton />
      </Card>

      {all.length > approved.length ? (
        <div className="mt-5">
          <InlineNotice tone="warning" title="Časť dochádzky ešte nie je schválená">
            {all.length - approved.length} riadkov čaká na schválenie a do hlavného exportu sa
            nedostane.
          </InlineNotice>
        </div>
      ) : null}
    </>
  );
}
