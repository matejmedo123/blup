"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createIncident, resolveIncident } from "@/app/actions/admin-performance";
import { Button } from "@/components/ui/Button";
import { SelectField, TextAreaField } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { INCIDENT_CATEGORIES, INCIDENT_SEVERITIES } from "@/db/enums";
import { INCIDENT_SEVERITY_META } from "@/components/ui/Badge";
import { INCIDENT_CATEGORY_LABELS } from "@/lib/labels";

export function NewIncidentButton({
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
  const [form, setForm] = useState({
    staffId: "",
    shiftId: "",
    severity: "medium",
    category: "other",
    description: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Nahlásiť incident
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nový incident"
        description="Vážne incidenty (vysoká a kritická závažnosť) znižujú Crew Score dotknutého človeka."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Zrušiť
            </Button>
            <Button
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await createIncident(form);
                  if (result.ok) {
                    toast.success(result.message ?? "Uložené.");
                    setOpen(false);
                    setForm({ ...form, description: "" });
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
              Uložiť incident
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Závažnosť"
              value={form.severity}
              onChange={(e) => setForm({ ...form, severity: e.target.value })}
              error={errors.severity}
            >
              {INCIDENT_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {INCIDENT_SEVERITY_META[severity].label}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Kategória"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              error={errors.category}
            >
              {INCIDENT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {INCIDENT_CATEGORY_LABELS[category]}
                </option>
              ))}
            </SelectField>
          </div>

          <SelectField
            label="Koho sa týka"
            value={form.staffId}
            onChange={(e) => setForm({ ...form, staffId: e.target.value })}
            error={errors.staffId}
            hint="Nepovinné — incident môže byť aj prevádzkový."
          >
            <option value="">Nikoho konkrétneho</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </SelectField>

          <SelectField
            label="Smena"
            value={form.shiftId}
            onChange={(e) => setForm({ ...form, shiftId: e.target.value })}
            error={errors.shiftId}
          >
            <option value="">Bez konkrétnej smeny</option>
            {shifts.map((shift) => (
              <option key={shift.id} value={shift.id}>
                {shift.label}
              </option>
            ))}
          </SelectField>

          <TextAreaField
            label="Čo sa stalo"
            required
            rows={4}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            error={errors.description}
            placeholder="Popíš situáciu vecne — kto, kedy, čo sa stalo."
          />
        </div>
      </Modal>
    </>
  );
}

export function ResolveIncidentButton({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState("");
  const [error, setError] = useState<string | undefined>();

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Vyriešiť
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Uzavrieť incident"
        description="Napíš, ako sa situácia vyriešila. Záznam ostáva v histórii."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Zrušiť
            </Button>
            <Button
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await resolveIncident({ incidentId, resolution });
                  if (result.ok) {
                    toast.success(result.message ?? "Vyriešené.");
                    setOpen(false);
                    router.refresh();
                  } else {
                    setError(result.fieldErrors?.resolution?.[0]);
                    toast.error(result.message);
                  }
                })
              }
            >
              Uzavrieť
            </Button>
          </>
        }
      >
        <TextAreaField
          label="Riešenie"
          required
          rows={3}
          value={resolution}
          error={error}
          onChange={(e) => setResolution(e.target.value)}
          placeholder="Napríklad: prehodený na inú pozíciu, situácia vysvetlená."
        />
      </Modal>
    </>
  );
}
