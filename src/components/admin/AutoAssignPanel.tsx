"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { confirmAutoAssignment, proposeAutoAssignment } from "@/app/actions/admin-shifts";
import { Pill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState, InlineNotice } from "@/components/ui/States";
import { IconSparkle } from "@/components/ui/Icons";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { formatDateShort, formatTimeRange } from "@/lib/format";

export type OpenShift = {
  id: string;
  positionName: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  capacity: number;
  filled: number;
};

type Proposal = {
  shiftId: string;
  positionName: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  alreadyFilled: number;
  needed: number;
  shortfall: number;
  picked: {
    userId: string;
    name: string;
    score: number;
    assignedHours: number;
    prefersPosition: boolean;
    available: boolean;
  }[];
};

export function AutoAssignPanel({
  shifts,
  timezone,
}: {
  shifts: OpenShift[];
  timezone: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set(shifts.map((s) => s.id)));
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  /** Odškrtnuté návrhy — admin môže jednotlivcov z návrhu vyradiť. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  function propose() {
    startTransition(async () => {
      const result = await proposeAutoAssignment({ shiftIds: [...selected], confirm: false });
      if (result.ok) {
        setProposals(result.data?.proposals ?? []);
        setExcluded(new Set());
        toast.info(result.message ?? "Návrh je pripravený.");
      } else {
        setProposals(null);
        toast.error(result.message);
      }
    });
  }

  function confirm() {
    if (!proposals) return;
    const assignments = proposals
      .map((proposal) => ({
        shiftId: proposal.shiftId,
        userIds: proposal.picked
          .filter((p) => !excluded.has(`${proposal.shiftId}:${p.userId}`))
          .map((p) => p.userId),
      }))
      .filter((group) => group.userIds.length > 0);

    if (assignments.length === 0) {
      toast.error("Návrh je prázdny — nič na potvrdenie.");
      return;
    }

    startTransition(async () => {
      const result = await confirmAutoAssignment({ assignments });
      if (result.ok) {
        toast.success(result.message ?? "Pridelené.");
        setProposals(null);
        router.refresh();
      } else toast.error(result.message);
    });
  }

  const totalPicked =
    proposals?.reduce(
      (sum, p) => sum + p.picked.filter((c) => !excluded.has(`${p.shiftId}:${c.userId}`)).length,
      0,
    ) ?? 0;

  if (shifts.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<IconSparkle width={26} height={26} />}
          title="Všetky smeny sú obsadené"
          description="Neobsadené smeny sa tu objavia automaticky. Zatiaľ netreba nič robiť."
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-5 sm:p-6">
        <h2 className="section-label mb-2">Neobsadené smeny</h2>
        <p className="mb-4 text-[15px] text-muted">
          Vyber smeny a nechaj systém navrhnúť obsadenie. Zohľadní preferovanú pozíciu, dostupnosť,
          už naplánované hodiny, konflikty a skóre. Nič sa nepridelí, kým návrh nepotvrdíš.
        </p>

        <ul className="flex flex-col gap-2">
          {shifts.map((shift) => (
            <li key={shift.id}>
              <label
                className={cn(
                  "flex cursor-pointer flex-wrap items-center gap-3 rounded-12 border p-3.5 transition-colors",
                  selected.has(shift.id) ? "border-ink bg-surface" : "border-line hover:bg-hover",
                )}
              >
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-ink"
                  checked={selected.has(shift.id)}
                  onChange={(e) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (e.target.checked) next.add(shift.id);
                      else next.delete(shift.id);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">
                    {shift.positionName}
                  </span>
                  <span className="nums block truncate text-[13px] text-muted">
                    {formatDateShort(shift.startsAt, timezone)} ·{" "}
                    {formatTimeRange(shift.startsAt, shift.endsAt, timezone)}
                    {shift.location ? ` · ${shift.location}` : ""}
                  </span>
                </span>
                <Pill kind={shift.filled === 0 ? "bad" : "warn"}>
                  {shift.filled} / {shift.capacity}
                </Pill>
              </label>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            onClick={propose}
            loading={pending && proposals === null}
            disabled={selected.size === 0}
            icon={<IconSparkle width={18} height={18} />}
          >
            Navrhnúť obsadenie ({selected.size})
          </Button>
          {selected.size < shifts.length ? (
            <Button variant="outline" onClick={() => setSelected(new Set(shifts.map((s) => s.id)))}>
              Označiť všetky
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setSelected(new Set())}>
              Zrušiť výber
            </Button>
          )}
        </div>
      </Card>

      {proposals ? (
        <Card className="p-5 sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="section-label">Návrh na schválenie</h2>
            <span className="text-[13px] text-muted">
              {totalPicked} {totalPicked === 1 ? "pridelenie" : "pridelení"}
            </span>
          </div>

          {proposals.some((p) => p.shortfall > 0) ? (
            <div className="mb-4">
              <InlineNotice tone="warning" title="Niektoré smeny sa nepodarilo doplniť">
                Buď nie je dosť voľnej crew, alebo majú kolízie s inými smenami. Skús rozšíriť
                dostupnosť alebo pridať ľudí manuálne.
              </InlineNotice>
            </div>
          ) : null}

          <ul className="flex flex-col gap-4">
            {proposals.map((proposal) => (
              <li key={proposal.shiftId} className="rounded-16 border border-line p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[15px] font-bold">{proposal.positionName}</p>
                  <p className="nums text-[13px] text-muted">
                    {formatDateShort(proposal.startsAt, timezone)} ·{" "}
                    {formatTimeRange(proposal.startsAt, proposal.endsAt, timezone)}
                  </p>
                </div>
                <p className="nums mt-1 text-[13px] text-muted">
                  Obsadené {proposal.alreadyFilled} / {proposal.capacity} · návrh dopĺňa{" "}
                  {proposal.picked.length}
                  {proposal.shortfall > 0 ? ` · chýba ešte ${proposal.shortfall}` : ""}
                </p>

                {proposal.picked.length === 0 ? (
                  <p className="mt-3 text-[13px] text-bad-fg">
                    Nikoho vhodného sme nenašli — všetci majú konflikt alebo sú mimo dostupnosti.
                  </p>
                ) : (
                  <ul className="mt-3 flex flex-col gap-2">
                    {proposal.picked.map((candidate) => {
                      const key = `${proposal.shiftId}:${candidate.userId}`;
                      const included = !excluded.has(key);
                      return (
                        <li key={key}>
                          <label className="flex cursor-pointer items-center gap-3 rounded-10 bg-subtle-2 px-3 py-2.5">
                            <input
                              type="checkbox"
                              className="size-4 shrink-0 accent-ink"
                              checked={included}
                              onChange={(e) =>
                                setExcluded((current) => {
                                  const next = new Set(current);
                                  if (e.target.checked) next.delete(key);
                                  else next.add(key);
                                  return next;
                                })
                              }
                            />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {candidate.name}
                            </span>
                            <span className="nums shrink-0 text-[13px] text-muted">
                              Score {candidate.score}
                              {candidate.prefersPosition ? " · preferuje" : ""}
                              {candidate.available ? " · voľný" : ""}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-5 flex flex-wrap gap-3 border-t border-line pt-5">
            <Button onClick={confirm} loading={pending} disabled={totalPicked === 0}>
              Potvrdiť a prideliť ({totalPicked})
            </Button>
            <Button variant="outline" onClick={() => setProposals(null)} disabled={pending}>
              Zahodiť návrh
            </Button>
          </div>
          <p className="mt-3 text-[13px] text-muted">
            Po potvrdení dostane každý notifikáciu a e-mail. Smenu musí ešte potvrdiť.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
