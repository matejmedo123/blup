"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveShift } from "@/app/actions/admin-shifts";
import { Button } from "@/components/ui/Button";
import { CheckboxField, SelectField, TextAreaField, TextField } from "@/components/ui/Field";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { CHECK_IN_METHODS, SHIFT_STATUSES, type CheckInMethod, type ShiftStatus } from "@/db/enums";
import { CHECK_IN_METHOD_LABELS } from "@/lib/labels";
import { SHIFT_STATUS_META } from "@/components/ui/Badge";

export type ShiftFormValues = {
  id?: string;
  positionId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  lat: string;
  lng: string;
  capacity: string;
  hourlyRate: string;
  status: ShiftStatus;
  checkInMethod: CheckInMethod;
  geofenceRadiusM: string;
  coordinatorId: string;
  instructions: string;
  dressCode: string;
  showColleagues: boolean;
};

export function ShiftForm({
  initial,
  positions,
  coordinators,
  defaultGeofenceRadius,
}: {
  initial: ShiftFormValues;
  positions: { id: string; name: string; hourlyRate: string }[];
  coordinators: { id: string; firstName: string; lastName: string }[];
  defaultGeofenceRadius: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<ShiftFormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const needsGeofence =
    values.checkInMethod === "geofence" || values.checkInMethod === "qr_geofence";
  const selectedPosition = positions.find((p) => p.id === values.positionId);

  function set<K extends keyof ShiftFormValues>(key: K, value: ShiftFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    setFormError(null);
    setErrors({});
    startTransition(async () => {
      const result = await saveShift({
        id: values.id,
        positionId: values.positionId,
        title: values.title,
        startsAt: values.startsAt,
        endsAt: values.endsAt,
        location: values.location,
        lat: values.lat === "" ? undefined : values.lat,
        lng: values.lng === "" ? undefined : values.lng,
        capacity: values.capacity,
        hourlyRate: values.hourlyRate === "" ? undefined : values.hourlyRate,
        status: values.status,
        checkInMethod: values.checkInMethod,
        geofenceRadiusM: values.geofenceRadiusM || defaultGeofenceRadius,
        coordinatorId: values.coordinatorId,
        instructions: values.instructions || undefined,
        dressCode: values.dressCode || undefined,
        showColleagues: values.showColleagues,
      });

      if (!result.ok) {
        setFormError(result.message);
        setErrors(
          Object.fromEntries(Object.entries(result.fieldErrors ?? {}).map(([k, v]) => [k, v[0]])),
        );
        toast.error(result.message);
        return;
      }

      toast.success(result.message ?? "Uložené.");
      router.push(`/admin/shifts/${result.data?.id}`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {formError ? (
        <InlineNotice tone="danger" title="Skontroluj formulár">
          {formError}
        </InlineNotice>
      ) : null}

      <div className="flex flex-col gap-4">
        <h2 className="text-[19px] font-bold tracking-[-0.02em]">Základ</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Pozícia"
            required
            value={values.positionId}
            onChange={(e) => set("positionId", e.target.value)}
            error={errors.positionId}
          >
            <option value="">Vyber pozíciu…</option>
            {positions.map((position) => (
              <option key={position.id} value={position.id}>
                {position.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Vlastný názov"
            value={values.title}
            onChange={(e) => set("title", e.target.value)}
            error={errors.title}
            placeholder="Bar — hlavná scéna"
            hint="Nepovinné. Bez neho sa použije názov pozície."
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Začiatok"
            type="datetime-local"
            required
            value={values.startsAt}
            onChange={(e) => set("startsAt", e.target.value)}
            error={errors.startsAt}
          />
          <TextField
            label="Koniec"
            type="datetime-local"
            required
            value={values.endsAt}
            onChange={(e) => set("endsAt", e.target.value)}
            error={errors.endsAt}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label="Kapacita"
            type="number"
            min="1"
            required
            inputMode="numeric"
            value={values.capacity}
            onChange={(e) => set("capacity", e.target.value)}
            error={errors.capacity}
          />
          <TextField
            label="Hodinová sadzba"
            type="number"
            step="0.10"
            min="0"
            inputMode="decimal"
            value={values.hourlyRate}
            onChange={(e) => set("hourlyRate", e.target.value)}
            error={errors.hourlyRate}
            placeholder={selectedPosition?.hourlyRate ?? ""}
            hint={
              selectedPosition
                ? `Prázdne = sadzba pozície (${selectedPosition.hourlyRate} €).`
                : "Prázdne = sadzba pozície."
            }
          />
          <SelectField
            label="Stav"
            value={values.status}
            onChange={(e) => set("status", e.target.value as ShiftStatus)}
            error={errors.status}
            hint="Crew vidí len zverejnené smeny."
          >
            {SHIFT_STATUSES.filter((s) => s !== "cancelled").map((status) => (
              <option key={status} value={status}>
                {SHIFT_STATUS_META[status].label}
              </option>
            ))}
          </SelectField>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-line pt-6">
        <h2 className="text-[19px] font-bold tracking-[-0.02em]">Miesto a check-in</h2>
        <TextField
          label="Miesto"
          value={values.location}
          onChange={(e) => set("location", e.target.value)}
          error={errors.location}
          placeholder="Hlavná scéna, brána C"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Spôsob check-inu"
            value={values.checkInMethod}
            onChange={(e) => set("checkInMethod", e.target.value as CheckInMethod)}
            error={errors.checkInMethod}
          >
            {CHECK_IN_METHODS.map((method) => (
              <option key={method} value={method}>
                {CHECK_IN_METHOD_LABELS[method]}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Koordinátor"
            value={values.coordinatorId}
            onChange={(e) => set("coordinatorId", e.target.value)}
            error={errors.coordinatorId}
            hint="Crew mu vie napísať priamo zo smeny."
          >
            <option value="">Bez koordinátora</option>
            {coordinators.map((person) => (
              <option key={person.id} value={person.id}>
                {person.firstName} {person.lastName}
              </option>
            ))}
          </SelectField>
        </div>

        {needsGeofence ? (
          <div className="grid gap-4 rounded-16 bg-subtle-2 p-4 sm:grid-cols-3">
            <TextField
              label="Zemepisná šírka"
              type="number"
              step="0.000001"
              required
              inputMode="decimal"
              value={values.lat}
              onChange={(e) => set("lat", e.target.value)}
              error={errors.lat}
              placeholder="48.148598"
            />
            <TextField
              label="Zemepisná dĺžka"
              type="number"
              step="0.000001"
              required
              inputMode="decimal"
              value={values.lng}
              onChange={(e) => set("lng", e.target.value)}
              error={errors.lng}
              placeholder="17.107748"
            />
            <TextField
              label="Polomer (m)"
              type="number"
              min="20"
              inputMode="numeric"
              value={values.geofenceRadiusM}
              onChange={(e) => set("geofenceRadiusM", e.target.value)}
              error={errors.geofenceRadiusM}
              hint="Mimo tohto okruhu sa crew nechekne."
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-4 border-t border-line pt-6">
        <h2 className="text-[19px] font-bold tracking-[-0.02em]">Pokyny pre crew</h2>
        <TextAreaField
          label="Inštrukcie"
          rows={4}
          value={values.instructions}
          onChange={(e) => set("instructions", e.target.value)}
          error={errors.instructions}
          placeholder="Príchod 17:45 pri bráne C, hlás sa Petrovi. Vodu a jedlo máš v crew zóne."
        />
        <TextField
          label="Dresscode"
          value={values.dressCode}
          onChange={(e) => set("dressCode", e.target.value)}
          error={errors.dressCode}
          placeholder="Čierne tričko, čierne nohavice, pohodlná obuv"
        />
        <CheckboxField
          label="Ukázať crew, kto ešte robí na tejto smene"
          hint="Vypni, ak nechceš zdieľať mená kolegov."
          checked={values.showColleagues}
          onChange={(e) => set("showColleagues", e.target.checked)}
        />
      </div>

      <div className="flex flex-wrap gap-3 border-t border-line pt-6">
        <Button onClick={submit} loading={pending}>
          {values.id ? "Uložiť zmeny" : "Vytvoriť smenu"}
        </Button>
        <Button variant="outline" onClick={() => router.back()} disabled={pending}>
          Zrušiť
        </Button>
      </div>
    </div>
  );
}
