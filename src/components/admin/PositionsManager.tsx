"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deletePosition, savePosition } from "@/app/actions/admin-positions";
import { Pill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CheckboxField, TextAreaField, TextField } from "@/components/ui/Field";
import { IconEdit, IconPlus, IconTrash } from "@/components/ui/Icons";
import { ConfirmDialog, Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { formatMoney } from "@/lib/format";

export type PositionRow = {
  id: string;
  name: string;
  description: string | null;
  hourlyRate: string;
  capacity: number;
  color: string;
  requiredSkills: string[];
  active: boolean;
  shiftCount: number;
};

const EMPTY = {
  id: undefined as string | undefined,
  name: "",
  description: "",
  hourlyRate: "8.50",
  capacity: "0",
  color: "#111111",
  requiredSkills: "",
  active: true,
};

export function PositionsManager({
  rows,
  currency,
  canManage,
}: {
  rows: PositionRow[];
  currency: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<PositionRow | null>(null);

  function openNew() {
    setErrors({});
    setForm({ ...EMPTY });
  }

  function openEdit(row: PositionRow) {
    setErrors({});
    setForm({
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      hourlyRate: row.hourlyRate,
      capacity: String(row.capacity),
      color: row.color,
      requiredSkills: row.requiredSkills.join(", "),
      active: row.active,
    });
  }

  function submit() {
    if (!form) return;
    startTransition(async () => {
      const result = await savePosition({
        id: form.id,
        name: form.name,
        description: form.description || undefined,
        hourlyRate: form.hourlyRate,
        capacity: form.capacity,
        color: form.color,
        requiredSkills: form.requiredSkills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        active: form.active,
      });
      if (result.ok) {
        toast.success(result.message ?? "Uložené.");
        setForm(null);
        router.refresh();
      } else {
        setErrors(
          Object.fromEntries(
            Object.entries(result.fieldErrors ?? {}).map(([k, v]) => [k, v[0]]),
          ),
        );
        toast.error(result.message);
      }
    });
  }

  function remove(row: PositionRow) {
    startTransition(async () => {
      const result = await deletePosition(row.id);
      if (result.ok) {
        toast.success(result.message ?? "Odstránené.");
        setConfirmDelete(null);
        router.refresh();
      } else toast.error(result.message);
    });
  }

  return (
    <>
      {canManage ? (
        <div className="mb-5">
          <Button icon={<IconPlus width={18} height={18} />} onClick={openNew}>
            Nová pozícia
          </Button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Žiadne pozície"
            description="Pozícia určuje názov práce, hodinovú sadzbu a farbu v kalendári. Bez nej sa nedá vytvoriť smena."
            action={
              canManage ? (
                <Button icon={<IconPlus width={18} height={18} />} onClick={openNew}>
                  Vytvoriť prvú pozíciu
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <li key={row.id}>
              <Card className="flex h-full flex-col p-5">
                <div className="flex items-start gap-3">
                  <span
                    className="mt-1 size-3 shrink-0 rounded-[3px]"
                    style={{ background: row.color }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[19px] font-bold tracking-[-0.02em]">{row.name}</h3>
                    <p className="nums mt-1 text-[15px] font-semibold">
                      {formatMoney(row.hourlyRate, currency)} / hod
                    </p>
                  </div>
                  {!row.active ? <Pill>Neaktívna</Pill> : null}
                </div>

                {row.description ? (
                  <p className="mt-3 text-sm leading-[1.6] text-muted">{row.description}</p>
                ) : null}

                {row.requiredSkills.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {row.requiredSkills.map((skill) => (
                      <Pill key={skill}>{skill}</Pill>
                    ))}
                  </div>
                ) : null}

                <p className="mt-3 text-[13px] text-faint">
                  {row.shiftCount} {row.shiftCount === 1 ? "smena" : row.shiftCount < 5 ? "smeny" : "smien"}
                  {row.capacity > 0 ? ` · odporúčaná kapacita ${row.capacity}` : ""}
                </p>

                {canManage ? (
                  <div className="mt-4 flex gap-2 border-t border-line pt-4">
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<IconEdit width={16} height={16} />}
                      onClick={() => openEdit(row)}
                    >
                      Upraviť
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconTrash width={16} height={16} />}
                      onClick={() => setConfirmDelete(row)}
                    >
                      Odstrániť
                    </Button>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? "Upraviť pozíciu" : "Nová pozícia"}
        description="Sadzba pozície sa použije na každú smenu, ktorá nemá vlastnú."
        footer={
          <>
            <Button variant="outline" onClick={() => setForm(null)}>
              Zrušiť
            </Button>
            <Button onClick={submit} loading={pending}>
              Uložiť
            </Button>
          </>
        }
      >
        {form ? (
          <div className="flex flex-col gap-4">
            <TextField
              label="Názov"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              error={errors.name}
              placeholder="Barman"
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Hodinová sadzba"
                type="number"
                step="0.10"
                min="0"
                required
                inputMode="decimal"
                value={form.hourlyRate}
                onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
                error={errors.hourlyRate}
              />
              <TextField
                label="Odporúčaná kapacita"
                type="number"
                min="0"
                inputMode="numeric"
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                error={errors.capacity}
                hint="Koľko ľudí zvyčajne treba. Kapacitu smeny nastavíš zvlášť."
              />
            </div>
            <TextAreaField
              label="Popis"
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              error={errors.description}
              placeholder="Čo práca obnáša — uvidí to crew pri smene."
            />
            <TextField
              label="Požadované zručnosti"
              value={form.requiredSkills}
              onChange={(e) => setForm({ ...form, requiredSkills: e.target.value })}
              error={errors.requiredSkills}
              placeholder="výčap, angličtina"
              hint="Oddeľ čiarkou."
            />
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold text-ink">Farba v kalendári</span>
                <input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                  className="h-11 w-20 cursor-pointer rounded-12 border border-line-strong bg-surface p-1"
                />
              </label>
              <div className="flex-1">
                <CheckboxField
                  label="Aktívna pozícia"
                  hint="Neaktívne pozície sa nedajú vybrať pri tvorbe smeny."
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                />
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        pending={pending}
        title={`Odstrániť pozíciu ${confirmDelete?.name ?? ""}?`}
        description={
          (confirmDelete?.shiftCount ?? 0) > 0
            ? "Pozícia má naviazané smeny, preto ju len deaktivujeme — historické dáta ostanú."
            : "Pozíciu odstránime. Táto akcia sa nedá vrátiť."
        }
        confirmLabel="Odstrániť"
      />
    </>
  );
}
