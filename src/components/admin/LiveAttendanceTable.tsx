"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  approveAttendance,
  coordinatorCheckAction,
  correctAttendance,
} from "@/app/actions/admin-attendance";
import { Avatar } from "@/components/ui/Avatar";
import { ATTENDANCE_STATUS_META, Pill, StatusPill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { TextAreaField, TextField } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { EmptyState, InlineNotice } from "@/components/ui/States";
import { IconClock } from "@/components/ui/Icons";
import { useToast } from "@/components/ui/Toast";
import type { AttendanceStatus } from "@/db/enums";
import { formatDuration, formatTime, formatTimeRange } from "@/lib/format";

import { BulkActionBar } from "./BulkActionBar";

export type LiveRow = {
  attendanceId: string | null;
  assignmentId: string;
  shiftId: string;
  userId: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  positionName: string;
  startsAt: string;
  endsAt: string;
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  approved: boolean;
  /** Lokálny čas eventu pre predvyplnenie korekcie. */
  checkInLocal: string;
  checkOutLocal: string;
};

export function LiveAttendanceTable({
  rows,
  timezone,
  canCheckIn,
  canCheckOut,
  canEdit,
}: {
  rows: LiveRow[];
  timezone: string;
  canCheckIn: boolean;
  canCheckOut: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<LiveRow | null>(null);
  const [form, setForm] = useState({
    checkInAt: "",
    checkOutAt: "",
    breakMinutes: "0",
    reason: "",
  });
  const [formError, setFormError] = useState<string | null>(null);

  function openEdit(row: LiveRow) {
    setFormError(null);
    setForm({
      checkInAt: row.checkInLocal,
      checkOutAt: row.checkOutLocal,
      breakMinutes: "0",
      reason: "",
    });
    setEditing(row);
  }

  function runCheck(row: LiveRow, action: "check_in" | "check_out") {
    startTransition(async () => {
      const result = await coordinatorCheckAction({
        shiftId: row.shiftId,
        userId: row.userId,
        action,
      });
      if (result.ok) {
        toast.success(result.message ?? "Hotovo.");
        router.refresh();
      } else toast.error(result.message);
    });
  }

  function saveCorrection() {
    if (!editing?.attendanceId) return;
    setFormError(null);
    startTransition(async () => {
      const result = await correctAttendance({
        attendanceId: editing.attendanceId,
        checkInAt: form.checkInAt,
        checkOutAt: form.checkOutAt,
        breakMinutes: form.breakMinutes,
        reason: form.reason,
      });
      if (result.ok) {
        toast.success(result.message ?? "Uložené.");
        setEditing(null);
        router.refresh();
      } else {
        setFormError(result.message);
        toast.error(result.message);
      }
    });
  }

  function approve(approved: boolean) {
    const ids = rows
      .filter((row) => selected.has(row.assignmentId) && row.attendanceId)
      .map((row) => row.attendanceId!);
    if (ids.length === 0) {
      toast.error("Označené záznamy nemajú dochádzku na schválenie.");
      return;
    }
    startTransition(async () => {
      const result = await approveAttendance({ attendanceIds: ids, approved });
      if (result.ok) {
        toast.success(result.message ?? "Hotovo.");
        setSelected(new Set());
        router.refresh();
      } else toast.error(result.message);
    });
  }

  const columns: Column<LiveRow>[] = [
    {
      key: "person",
      header: "Človek",
      cell: (row) => (
        <span className="flex items-center gap-3">
          <Avatar firstName={row.firstName} lastName={row.lastName} src={row.avatarUrl} size="xs" />
          <span className="truncate text-[15px] font-semibold">
            {row.firstName} {row.lastName}
          </span>
        </span>
      ),
    },
    {
      key: "position",
      header: "Pozícia",
      cell: (row) => <span className="text-sm text-body">{row.positionName}</span>,
    },
    {
      key: "shift",
      header: "Smena",
      cell: (row) => (
        <span className="nums text-sm text-muted">
          {formatTimeRange(row.startsAt, row.endsAt, timezone)}
        </span>
      ),
    },
    {
      key: "in",
      header: "Check-in",
      cell: (row) => (
        <span className="nums text-sm">{row.checkInAt ? formatTime(row.checkInAt, timezone) : "—"}</span>
      ),
    },
    {
      key: "out",
      header: "Check-out",
      cell: (row) => (
        <span className="nums text-sm text-muted">
          {row.checkOutAt ? formatTime(row.checkOutAt, timezone) : "—"}
        </span>
      ),
    },
    {
      key: "hours",
      header: "Hodiny",
      cell: (row) => (
        <span className="nums text-[15px] font-bold">{formatDuration(row.workedMinutes)}</span>
      ),
    },
    {
      key: "status",
      header: "Stav",
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={row.status} meta={ATTENDANCE_STATUS_META} />
          {row.approved ? <Pill kind="ok">Schválené</Pill> : null}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (row) => (
        <span className="flex justify-end gap-1.5">
          {!row.checkInAt && canCheckIn ? (
            <Button size="sm" disabled={pending} onClick={() => runCheck(row, "check_in")}>
              Check-in
            </Button>
          ) : null}
          {row.checkInAt && !row.checkOutAt && canCheckOut ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => runCheck(row, "check_out")}>
              Check-out
            </Button>
          ) : null}
          {canEdit && row.attendanceId ? (
            <Button size="sm" variant="ghost" onClick={() => openEdit(row)}>
              Opraviť
            </Button>
          ) : null}
        </span>
      ),
      hideOnCard: true,
    },
  ];

  return (
    <>
      {canEdit ? (
        <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <Button size="sm" disabled={pending} onClick={() => approve(true)}>
            Schváliť dochádzku
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => approve(false)}>
            Zrušiť schválenie
          </Button>
        </BulkActionBar>
      ) : null}

      <DataTable
        rows={rows}
        columns={columns}
        getKey={(row) => row.assignmentId}
        selection={
          canEdit
            ? {
                selected,
                onToggle: (key) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  }),
                onToggleAll: (keys) =>
                  setSelected((current) =>
                    keys.every((k) => current.has(k)) ? new Set() : new Set([...current, ...keys]),
                  ),
              }
            : undefined
        }
        empty={
          <EmptyState
            icon={<IconClock width={26} height={26} />}
            title="Dnes žiadna dochádzka"
            description="Keď sa niekto checkne na smenu, objaví sa tu v reálnom čase."
          />
        }
        card={(row) => (
          <>
            <div className="flex items-center gap-3">
              <Avatar firstName={row.firstName} lastName={row.lastName} src={row.avatarUrl} size="xs" />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">
                  {row.firstName} {row.lastName}
                </p>
                <p className="nums truncate text-[13px] text-muted">
                  {row.positionName} · {formatTimeRange(row.startsAt, row.endsAt, timezone)}
                </p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusPill status={row.status} meta={ATTENDANCE_STATUS_META} />
              <span className="nums text-[13px] font-semibold">
                {formatDuration(row.workedMinutes)}
              </span>
              {row.checkInAt ? (
                <span className="nums text-[13px] text-muted">
                  od {formatTime(row.checkInAt, timezone)}
                </span>
              ) : null}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {!row.checkInAt && canCheckIn ? (
                <Button size="sm" disabled={pending} onClick={() => runCheck(row, "check_in")}>
                  Check-in
                </Button>
              ) : null}
              {row.checkInAt && !row.checkOutAt && canCheckOut ? (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => runCheck(row, "check_out")}>
                  Check-out
                </Button>
              ) : null}
              {canEdit && row.attendanceId ? (
                <Button size="sm" variant="ghost" onClick={() => openEdit(row)}>
                  Opraviť
                </Button>
              ) : null}
            </div>
          </>
        )}
      />

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Opraviť dochádzku"
        description={
          editing
            ? `${editing.firstName} ${editing.lastName} · ${editing.positionName}`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Zrušiť
            </Button>
            <Button onClick={saveCorrection} loading={pending} disabled={form.reason.trim().length < 3}>
              Uložiť opravu
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null}
          <InlineNotice tone="info">
            Každá zmena sa zapíše do audit logu spolu s dôvodom a tvojím menom. Oprava zruší
            schválenie dochádzky — payroll ju bude musieť schváliť znova.
          </InlineNotice>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Check-in"
              type="datetime-local"
              value={form.checkInAt}
              onChange={(e) => setForm({ ...form, checkInAt: e.target.value })}
            />
            <TextField
              label="Check-out"
              type="datetime-local"
              value={form.checkOutAt}
              onChange={(e) => setForm({ ...form, checkOutAt: e.target.value })}
            />
          </div>
          <TextField
            label="Prestávka (min)"
            type="number"
            min="0"
            inputMode="numeric"
            value={form.breakMinutes}
            onChange={(e) => setForm({ ...form, breakMinutes: e.target.value })}
            hint="Odráta sa od odpracovaného času."
          />
          <TextAreaField
            label="Dôvod opravy"
            required
            rows={3}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            placeholder="Napríklad: vybitý telefón, check-in nahlásený koordinátorovi o 18:05."
          />
        </div>
      </Modal>
    </>
  );
}
