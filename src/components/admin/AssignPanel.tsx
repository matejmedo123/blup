"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { assignStaff, removeAssignment } from "@/app/actions/admin-shifts";
import { Avatar } from "@/components/ui/Avatar";
import { ASSIGNMENT_STATUS_META, Pill, StatusPill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Modal } from "@/components/ui/Modal";
import { EmptyState, InlineNotice } from "@/components/ui/States";
import { IconPlus, IconSearch } from "@/components/ui/Icons";
import { useToast } from "@/components/ui/Toast";
import type { AssignmentStatus } from "@/db/enums";
import { cn } from "@/lib/cn";
import { formatDateTime, formatDuration } from "@/lib/format";

export type AssignedPerson = {
  assignmentId: string;
  userId: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  phone: string | null;
  status: AssignmentStatus;
  needsReplacement: boolean;
  workedMinutes: number | null;
  checkInAt: string | null;
};

export type SuggestedPerson = {
  userId: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  score: number;
  assignedHours: number;
  prefersPosition: boolean;
  available: boolean;
  blockers: string[];
};

export function AssignPanel({
  shiftId,
  capacity,
  assigned,
  suggestions,
  canManage,
  timezone,
}: {
  shiftId: string;
  capacity: number;
  assigned: AssignedPerson[];
  suggestions: SuggestedPerson[];
  canManage: boolean;
  timezone: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState<AssignedPerson | null>(null);

  const activeCount = assigned.filter(
    (a) => a.status !== "cancelled" && a.status !== "declined",
  ).length;
  const free = Math.max(0, capacity - activeCount);
  const fillPercent = capacity > 0 ? Math.min(100, Math.round((activeCount / capacity) * 100)) : 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suggestions;
    return suggestions.filter((person) =>
      `${person.firstName} ${person.lastName}`.toLowerCase().includes(q),
    );
  }, [suggestions, query]);

  function assign(userIds: string[]) {
    if (userIds.length === 0) return;
    startTransition(async () => {
      const result = await assignStaff({ shiftId, userIds });
      if (result.ok) {
        toast.success(result.message ?? "Pridelené.");
        setSelected(new Set());
        setPickerOpen(false);
        router.refresh();
      } else toast.error(result.message);
    });
  }

  function remove(person: AssignedPerson) {
    startTransition(async () => {
      const result = await removeAssignment({ assignmentId: person.assignmentId });
      if (result.ok) {
        toast.success(result.message ?? "Zrušené.");
        setConfirmRemove(null);
        router.refresh();
      } else toast.error(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-16 bg-subtle-2 p-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-muted">Kapacita</span>
          <span className="nums text-xl font-extrabold tracking-[-0.02em]">
            {activeCount} / {capacity}
          </span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-[4px] bg-track">
          <div
            className={cn("h-full transition-[width] duration-300", activeCount >= capacity ? "bg-ok-dot" : "bg-ink")}
            style={{ width: `${fillPercent}%` }}
          />
        </div>
        {free > 0 ? (
          <p className="mt-2.5 text-[13px] text-muted">
            Zostáva {free} {free === 1 ? "voľné miesto" : free < 5 ? "voľné miesta" : "voľných miest"}.
          </p>
        ) : (
          <p className="mt-2.5 text-[13px] text-ok-fg">Smena je plne obsadená.</p>
        )}
      </div>

      <div>
        <div className="mb-3.5 flex items-center justify-between gap-3">
          <h2 className="section-label">Pridelená crew</h2>
          {canManage ? (
            <Button size="sm" icon={<IconPlus width={16} height={16} />} onClick={() => setPickerOpen(true)}>
              Priradiť
            </Button>
          ) : null}
        </div>

        {assigned.length === 0 ? (
          <EmptyState
            title="Zatiaľ nikto"
            description="Na tejto smene ešte nikto nie je. Priraď crew manuálne alebo použi automatický návrh."
            action={
              canManage ? (
                <Button size="sm" onClick={() => setPickerOpen(true)}>
                  Priradiť crew
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="flex flex-col gap-2.5">
            {assigned.map((person) => (
              <li
                key={person.assignmentId}
                className="flex flex-wrap items-center gap-3 rounded-16 border border-line p-3.5"
              >
                <Avatar
                  firstName={person.firstName}
                  lastName={person.lastName}
                  src={person.avatarUrl}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold">
                    {person.firstName} {person.lastName}
                  </p>
                  <p className="nums truncate text-[13px] text-muted">
                    {person.checkInAt
                      ? `check-in ${formatDateTime(person.checkInAt, timezone)}`
                      : person.phone || "—"}
                    {person.workedMinutes ? ` · ${formatDuration(person.workedMinutes)}` : ""}
                  </p>
                </div>
                {person.needsReplacement ? <Pill kind="bad">Potrebuje náhradu</Pill> : null}
                <StatusPill status={person.status} meta={ASSIGNMENT_STATUS_META} />
                {canManage && person.status !== "cancelled" ? (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(person)}>
                    Odobrať
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canManage && suggestions.length > 0 ? (
        <div>
          <h2 className="section-label mb-3.5">Odporúčaná crew</h2>
          <ul className="flex flex-col gap-2.5">
            {suggestions.slice(0, 5).map((person) => (
              <li
                key={person.userId}
                className="flex flex-wrap items-center gap-3 rounded-16 border border-line p-3.5"
              >
                <Avatar
                  firstName={person.firstName}
                  lastName={person.lastName}
                  src={person.avatarUrl}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold">
                    {person.firstName} {person.lastName}
                  </p>
                  <p className="truncate text-[13px] text-muted">
                    Score {person.score}
                    {person.prefersPosition ? " · preferuje pozíciu" : ""}
                    {person.available ? " · voľný" : " · mimo dostupnosti"}
                    {person.assignedHours > 0 ? ` · ${person.assignedHours} h naplánovaných` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={pending || free === 0}
                  onClick={() => assign([person.userId])}
                >
                  Priradiť
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Priradiť crew"
        description={`Voľných miest: ${free}. Systém nikdy nepriradí človeka na dve prekrývajúce sa smeny.`}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setPickerOpen(false)}>
              Zrušiť
            </Button>
            <Button
              onClick={() => assign([...selected])}
              loading={pending}
              disabled={selected.size === 0}
            >
              Priradiť ({selected.size})
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Hľadať meno…"
              aria-label="Hľadať crew"
              className="h-11 w-full rounded-12 border border-line-strong bg-surface pr-3 pl-10 text-[15px] placeholder:text-faint focus:border-ink focus:outline-none"
            />
          </div>

          {selected.size > free ? (
            <InlineNotice tone="warning">
              Vybral si viac ľudí, než je voľných miest. Zväčši kapacitu smeny alebo zúž výber.
            </InlineNotice>
          ) : null}

          {filtered.length === 0 ? (
            <EmptyState
              title="Nikto nevyhovuje"
              description="Skús iné meno, alebo najprv schváľ prihlášky — crew sa objaví tu."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {filtered.map((person) => {
                const blocked = person.blockers.length > 0;
                const checked = selected.has(person.userId);
                return (
                  <li key={person.userId}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-12 border p-3 transition-colors",
                        blocked
                          ? "cursor-not-allowed border-line bg-hover opacity-70"
                          : checked
                            ? "border-ink bg-surface"
                            : "border-line hover:bg-hover",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-5 shrink-0 accent-ink"
                        disabled={blocked}
                        checked={checked}
                        onChange={(e) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (e.target.checked) next.add(person.userId);
                            else next.delete(person.userId);
                            return next;
                          })
                        }
                      />
                      <Avatar
                        firstName={person.firstName}
                        lastName={person.lastName}
                        src={person.avatarUrl}
                        size="sm"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold">
                          {person.firstName} {person.lastName}
                        </span>
                        <span className="block truncate text-[13px] text-muted">
                          {blocked
                            ? person.blockers.join(", ")
                            : `Score ${person.score}${person.prefersPosition ? " · preferuje pozíciu" : ""}${person.available ? " · voľný" : ""}`}
                        </span>
                      </span>
                      {blocked ? <Pill kind="bad">Nedostupný</Pill> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => confirmRemove && remove(confirmRemove)}
        pending={pending}
        title="Odobrať zo smeny?"
        description={`${confirmRemove?.firstName ?? ""} ${confirmRemove?.lastName ?? ""} dostane notifikáciu, že už na smene nie je.`}
        confirmLabel="Odobrať"
      />
    </div>
  );
}
