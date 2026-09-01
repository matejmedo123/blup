"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { updateEventSettings } from "@/app/actions/admin-settings";
import { Button } from "@/components/ui/Button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/Field";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { EVENT_STATUSES } from "@/db/enums";

const STATUS_LABELS: Record<string, string> = {
  draft: "Koncept — verejné prihlášky sú zatvorené",
  active: "Aktívny — prihlášky sú otvorené",
  archived: "Archivovaný",
};

export type EventFormValues = {
  name: string;
  description: string;
  location: string;
  lat: string;
  lng: string;
  startDate: string;
  endDate: string;
  timezone: string;
  status: string;
  currency: string;
  rounding: string;
  overtimeAfterHours: string;
  overtimeMultiplier: string;
  defaultGeofenceRadiusM: string;
  reminderHoursBefore: string;
};

export function EventSettingsForm({ initial }: { initial: EventFormValues }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function set<K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="flex flex-col gap-6">
      {formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null}

      <div className="flex flex-col gap-4">
        <h2 className="text-[19px] font-bold tracking-[-0.02em]">Event</h2>
        <TextField
          label="Názov"
          required
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          error={errors.name}
        />
        <TextAreaField
          label="Popis"
          rows={3}
          value={values.description}
          onChange={(e) => set("description", e.target.value)}
          error={errors.description}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Začiatok"
            type="date"
            required
            value={values.startDate}
            onChange={(e) => set("startDate", e.target.value)}
            error={errors.startDate}
          />
          <TextField
            label="Koniec"
            type="date"
            required
            value={values.endDate}
            onChange={(e) => set("endDate", e.target.value)}
            error={errors.endDate}
          />
        </div>
        <TextField
          label="Miesto"
          value={values.location}
          onChange={(e) => set("location", e.target.value)}
          error={errors.location}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label="Zemepisná šírka"
            type="number"
            step="0.000001"
            value={values.lat}
            onChange={(e) => set("lat", e.target.value)}
            error={errors.lat}
            hint="Predvolená poloha pre nové smeny."
          />
          <TextField
            label="Zemepisná dĺžka"
            type="number"
            step="0.000001"
            value={values.lng}
            onChange={(e) => set("lng", e.target.value)}
            error={errors.lng}
          />
          <TextField
            label="Časové pásmo"
            required
            value={values.timezone}
            onChange={(e) => set("timezone", e.target.value)}
            error={errors.timezone}
            hint="Napríklad Europe/Bratislava."
          />
        </div>
        <SelectField
          label="Stav eventu"
          value={values.status}
          onChange={(e) => set("status", e.target.value)}
          error={errors.status}
        >
          {EVENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="flex flex-col gap-4 border-t border-line pt-6">
        <h2 className="text-[19px] font-bold tracking-[-0.02em]">Mzdy a čas</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Mena"
            required
            value={values.currency}
            onChange={(e) => set("currency", e.target.value.toUpperCase())}
            error={errors.currency}
          />
          <SelectField
            label="Zaokrúhľovanie času"
            value={values.rounding}
            onChange={(e) => set("rounding", e.target.value)}
            error={errors.rounding}
            hint="Platí pre výpočet odpracovaných hodín."
          >
            <option value="exact">Presne na minúty</option>
            <option value="5min">Na 5 minút</option>
            <option value="15min">Na 15 minút</option>
          </SelectField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Nadčas začína po (hodín)"
            type="number"
            min="4"
            max="24"
            required
            value={values.overtimeAfterHours}
            onChange={(e) => set("overtimeAfterHours", e.target.value)}
            error={errors.overtimeAfterHours}
          />
          <TextField
            label="Násobok za nadčas"
            type="number"
            step="0.05"
            min="1"
            max="3"
            required
            value={values.overtimeMultiplier}
            onChange={(e) => set("overtimeMultiplier", e.target.value)}
            error={errors.overtimeMultiplier}
            hint="1,25 znamená +25 % k sadzbe."
          />
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-line pt-6">
        <h2 className="text-[19px] font-bold tracking-[-0.02em]">Check-in a pripomienky</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Predvolený polomer geofence (m)"
            type="number"
            min="20"
            required
            value={values.defaultGeofenceRadiusM}
            onChange={(e) => set("defaultGeofenceRadiusM", e.target.value)}
            error={errors.defaultGeofenceRadiusM}
          />
          <TextField
            label="Pripomienka smeny (hodín vopred)"
            type="number"
            min="1"
            max="168"
            required
            value={values.reminderHoursBefore}
            onChange={(e) => set("reminderHoursBefore", e.target.value)}
            error={errors.reminderHoursBefore}
            hint="24 znamená deň vopred."
          />
        </div>
      </div>

      <div className="border-t border-line pt-6">
        <Button
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              setFormError(null);
              setErrors({});
              const result = await updateEventSettings(values);
              if (result.ok) {
                toast.success(result.message ?? "Uložené.");
                router.refresh();
              } else {
                setFormError(result.message);
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
          Uložiť nastavenia
        </Button>
      </div>
    </div>
  );
}
