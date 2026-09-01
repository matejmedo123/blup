import type { Metadata } from "next";

import { Pill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card, DarkCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconEuro } from "@/components/ui/Icons";
import { requireStaff } from "@/lib/auth/guards";
import { eventSettings, getEventById } from "@/lib/domain/events";
import { calculateEarnings } from "@/lib/domain/payroll";
import { portalShifts } from "@/lib/domain/portal";
import { formatDateShort, formatDuration, formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Zárobok" };

export default async function PortalEarningsPage() {
  const session = await requireStaff();
  if (!session.eventId) return null;

  const event = await getEventById(session.eventId);
  if (!event) return null;

  const tz = event.timezone;
  const settings = eventSettings(event);
  const shifts = await portalShifts(session.user.id, session.eventId);

  const worked = shifts.all
    .filter((row) => (row.workedMinutes ?? 0) > 0)
    .map((row) => ({
      ...row,
      earnings: calculateEarnings(
        {
          workedMinutes: row.workedMinutes ?? 0,
          hourlyRate: row.rate,
          bonus: Number(row.bonus ?? 0),
          adjustments: Number(row.adjustments ?? 0),
        },
        settings,
      ),
    }));

  const totalMinutes = worked.reduce((sum, row) => sum + (row.workedMinutes ?? 0), 0);
  const total = worked.reduce((sum, row) => sum + row.earnings.total, 0);
  const approved = worked
    .filter((row) => row.approved)
    .reduce((sum, row) => sum + row.earnings.total, 0);
  const averageRate = totalMinutes > 0 ? total / (totalMinutes / 60) : 0;

  return (
    <div className="animate-(--animate-crew-up) flex flex-col gap-5">
      <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.035em] sm:text-[30px]">
        Tvoj zárobok
      </h1>

      <DarkCard className="p-6">
        <p className="text-[13px] text-white/60">Tento event · {event.name}</p>
        <p className="nums mt-1.5 mb-0.5 text-[40px] leading-none font-extrabold tracking-[-0.045em] sm:text-[46px]">
          {formatMoney(total, settings.currency)}
        </p>
        <p className="nums text-sm text-white/60">
          {formatDuration(totalMinutes)} · priemer {formatMoney(averageRate, settings.currency)} / hod
        </p>
      </DarkCard>

      {approved < total ? (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[15px] font-semibold">Schválené na výplatu</p>
              <p className="mt-1 text-[13px] text-muted">
                Zvyšok ešte kontroluje koordinátor. Suma sa môže zmeniť, ak sa opraví dochádzka.
              </p>
            </div>
            <p className="nums text-xl font-bold">{formatMoney(approved, settings.currency)}</p>
          </div>
        </Card>
      ) : null}

      {worked.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconEuro width={26} height={26} />}
            title="Zatiaľ žiadny zárobok"
            description="Zárobok vzniká automaticky z check-inu a check-outu. Po prvej odpracovanej smene ho uvidíš tu."
            action={<ButtonLink href="/portal/shifts">Moje smeny</ButtonLink>}
          />
        </Card>
      ) : (
        <Card className="px-5 py-1">
          {worked.map((row) => (
            <div
              key={row.assignmentId}
              className="flex items-center justify-between gap-3 border-b border-divider py-[15px] last:border-b-0"
            >
              <div className="min-w-0">
                <p className="nums text-[15px] font-semibold">
                  {formatDateShort(row.startsAt, tz)}
                </p>
                <p className="truncate text-[13px] text-muted">{row.title ?? row.positionName}</p>
              </div>
              <p className="nums shrink-0 text-sm text-muted">
                {formatDuration(row.workedMinutes)} × {formatMoney(row.rate, settings.currency)}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                {!row.approved ? <Pill kind="warn">Čaká</Pill> : null}
                <p className="nums text-base font-bold">
                  {formatMoney(row.earnings.total, settings.currency)}
                </p>
              </div>
            </div>
          ))}
        </Card>
      )}

      <p className="text-[13px] leading-[1.5] text-muted">
        Sumy sú orientačné a počítajú sa z aktuálnej dochádzky. Vyplatená suma vychádza zo
        schválených dochádzkových údajov.
      </p>
    </div>
  );
}
