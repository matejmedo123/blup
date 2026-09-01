"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { adjustCrewScore, saveScoreRules } from "@/app/actions/admin-performance";
import { Button } from "@/components/ui/Button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

export type RuleRow = { key: string; label: string; delta: number; active: boolean };

export function ScoreRulesForm({ rules: initial }: { rules: RuleRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [rules, setRules] = useState(initial);

  function update(key: string, patch: Partial<RuleRow>) {
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <InlineNotice tone="info">
        Skóre začína na 70 a drží sa v rozsahu 0–100. Automatické prideľovanie ho berie ako jeden
        z faktorov, nikdy nie ako jediný.
      </InlineNotice>

      <ul className="flex flex-col divide-y divide-divider">
        {rules.map((rule) => (
          <li key={rule.key} className="flex flex-col gap-3 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold">{rule.label}</p>
              <p className="truncate text-[13px] text-faint">{rule.key}</p>
            </div>

            <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              <span className="text-[13px] text-muted">Body</span>
              <input
                type="number"
                min={-100}
                max={100}
                value={rule.delta}
                onChange={(e) => update(rule.key, { delta: Number(e.target.value) })}
                className="nums h-11 w-20 rounded-12 border border-line-strong bg-surface px-3 text-center text-[15px] font-semibold focus:border-ink focus:outline-none"
              />
            </label>

            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="size-5 accent-ink"
                checked={rule.active}
                onChange={(e) => update(rule.key, { active: e.target.checked })}
              />
              <span className="text-[13px] text-muted">Aktívne</span>
            </label>
            </div>
          </li>
        ))}
      </ul>

      <Button
        className="self-start"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await saveScoreRules({ rules });
            if (result.ok) {
              toast.success(result.message ?? "Uložené.");
              router.refresh();
            } else toast.error(result.message);
          })
        }
      >
        Uložiť pravidlá
      </Button>
    </div>
  );
}

export function ManualScoreButton({ staff }: { staff: { id: string; name: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ userId: "", delta: "5", reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Upraviť skóre ručne
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Manuálna úprava skóre"
        description="Úprava sa zapíše do histórie skóre aj do audit logu."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Zrušiť
            </Button>
            <Button
              loading={pending}
              disabled={!form.userId}
              onClick={() =>
                startTransition(async () => {
                  const result = await adjustCrewScore(form);
                  if (result.ok) {
                    toast.success(result.message ?? "Uložené.");
                    setOpen(false);
                    setForm({ ...form, reason: "" });
                    router.refresh();
                  } else {
                    setErrors(
                      Object.fromEntries(
                        Object.entries(result.fieldErrors ?? {}).map(([k, v]) => [k, v[0]]),
                      ),
                    );
                    toast.error(result.message);
                  }
                })
              }
            >
              Uložiť
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <SelectField
            label="Pracovník"
            required
            value={form.userId}
            onChange={(e) => setForm({ ...form, userId: e.target.value })}
            error={errors.userId}
          >
            <option value="">Vyber pracovníka…</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Zmena skóre"
            type="number"
            required
            value={form.delta}
            onChange={(e) => setForm({ ...form, delta: e.target.value })}
            error={errors.delta}
            hint="Kladné číslo pridáva, záporné uberá."
          />
          <TextAreaField
            label="Dôvod"
            required
            rows={3}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            error={errors.reason}
            placeholder="Napríklad: zaskočil za kolegu na poslednú chvíľu."
          />
        </div>
      </Modal>
    </>
  );
}
