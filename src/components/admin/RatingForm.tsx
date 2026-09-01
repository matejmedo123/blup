"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { rateStaff } from "@/app/actions/admin-performance";
import { Button } from "@/components/ui/Button";
import { SelectField, TextAreaField } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

const CATEGORIES = [
  { key: "reliability", label: "Spoľahlivosť" },
  { key: "punctuality", label: "Dochvíľnosť" },
  { key: "workEthic", label: "Pracovitosť" },
  { key: "communication", label: "Komunikácia" },
  { key: "quality", label: "Kvalita práce" },
] as const;

type Scores = Record<(typeof CATEGORIES)[number]["key"], number>;

export function RatingForm({
  staff,
  shifts,
}: {
  staff: { id: string; name: string }[];
  shifts: { id: string; label: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [staffId, setStaffId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [note, setNote] = useState("");
  const [scores, setScores] = useState<Scores>({
    reliability: 4,
    punctuality: 4,
    workEthic: 4,
    communication: 4,
    quality: 4,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const overall =
    Object.values(scores).reduce((sum, value) => sum + value, 0) / CATEGORIES.length;

  function submit() {
    setErrors({});
    startTransition(async () => {
      const result = await rateStaff({ staffId, shiftId: shiftId || undefined, note, ...scores });
      if (result.ok) {
        toast.success(result.message ?? "Uložené.");
        setOpen(false);
        setNote("");
        router.refresh();
      } else {
        setErrors(
          Object.fromEntries(Object.entries(result.fieldErrors ?? {}).map(([k, v]) => [k, v[0]])),
        );
        toast.error(result.message);
      }
    });
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Ohodnotiť pracovníka
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Hodnotenie pracovníka"
        description="Hodnotenie vidí pracovník vo svojom profile. Priemer nad 4 dvíha Crew Score."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Zrušiť
            </Button>
            <Button onClick={submit} loading={pending} disabled={!staffId}>
              Uložiť hodnotenie
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <SelectField
            label="Pracovník"
            required
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            error={errors.staffId}
          >
            <option value="">Vyber pracovníka…</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Smena"
            value={shiftId}
            onChange={(e) => setShiftId(e.target.value)}
            error={errors.shiftId}
            hint="Nepovinné — hodnotenie môže byť aj celkové."
          >
            <option value="">Bez konkrétnej smeny</option>
            {shifts.map((shift) => (
              <option key={shift.id} value={shift.id}>
                {shift.label}
              </option>
            ))}
          </SelectField>

          <div className="flex flex-col gap-3">
            {CATEGORIES.map((category) => (
              <div key={category.key} className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm font-medium">{category.label}</span>
                <div className="flex gap-1.5" role="radiogroup" aria-label={category.label}>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={scores[category.key] === value}
                      onClick={() => setScores({ ...scores, [category.key]: value })}
                      className={cn(
                        "nums size-10 cursor-pointer rounded-10 text-sm font-bold transition-colors",
                        scores[category.key] === value
                          ? "bg-ink text-white"
                          : "border border-line-strong bg-surface text-muted hover:bg-hover",
                      )}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-12 bg-subtle-2 px-4 py-3">
            <p className="nums text-[15px] font-semibold">
              Celkovo {overall.toFixed(2)} / 5
            </p>
          </div>

          <TextAreaField
            label="Poznámka"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            error={errors.note}
            placeholder="Čo fungovalo, čo zlepšiť."
          />
        </div>
      </Modal>
    </>
  );
}
