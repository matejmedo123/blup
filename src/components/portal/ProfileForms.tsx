"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { exportOwnData, updateOwnAvailability, updateOwnProfile } from "@/app/actions/portal";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { formatDateWithWeekday } from "@/lib/format";

export function ProfileForm({
  phone,
  city,
  avatarUrl,
}: {
  phone: string;
  city: string;
  avatarUrl: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState({ phone, city, avatarUrl });
  const [errors, setErrors] = useState<Record<string, string>>({});

  return (
    <div className="flex flex-col gap-4">
      <TextField
        label="Telefón"
        type="tel"
        value={values.phone}
        onChange={(e) => setValues({ ...values, phone: e.target.value })}
        error={errors.phone}
      />
      <TextField
        label="Mesto"
        value={values.city}
        onChange={(e) => setValues({ ...values, city: e.target.value })}
        error={errors.city}
      />
      <TextField
        label="Profilová fotografia"
        type="url"
        placeholder="https://…"
        value={values.avatarUrl}
        onChange={(e) => setValues({ ...values, avatarUrl: e.target.value })}
        error={errors.avatarUrl}
      />
      <Button
        className="self-start"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await updateOwnProfile(values);
            if (result.ok) {
              toast.success(result.message ?? "Uložené.");
              setErrors({});
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
        Uložiť profil
      </Button>
    </div>
  );
}

export function AvailabilityForm({
  eventDays,
  timezone,
  initial,
  initialMaxHours,
}: {
  eventDays: string[];
  timezone: string;
  initial: Record<string, { timeFrom: string; timeTo: string }>;
  initialMaxHours: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [days, setDays] = useState(initial);
  const [maxHours, setMaxHours] = useState(initialMaxHours);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2.5">
        {eventDays.map((day) => {
          const selected = day in days;
          return (
            <div
              key={day}
              className={cn(
                "rounded-16 border p-3.5 transition-colors",
                selected ? "border-ink bg-surface" : "border-line bg-hover",
              )}
            >
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-ink"
                  checked={selected}
                  onChange={(e) => {
                    setDays((current) => {
                      const next = { ...current };
                      if (e.target.checked) next[day] = { timeFrom: "08:00", timeTo: "22:00" };
                      else delete next[day];
                      return next;
                    });
                  }}
                />
                <span className="text-[15px] font-semibold capitalize">
                  {formatDateWithWeekday(`${day}T12:00:00Z`, timezone)}
                </span>
              </label>
              {selected ? (
                <div className="mt-3 grid grid-cols-2 gap-3 pl-8">
                  {(["timeFrom", "timeTo"] as const).map((bound) => (
                    <label key={bound} className="flex flex-col gap-1">
                      <span className="text-xs font-semibold text-muted">
                        {bound === "timeFrom" ? "Od" : "Do"}
                      </span>
                      <input
                        type="time"
                        value={days[day][bound]}
                        onChange={(e) =>
                          setDays((current) => ({
                            ...current,
                            [day]: { ...current[day], [bound]: e.target.value },
                          }))
                        }
                        className="h-11 rounded-12 border border-line-strong bg-surface px-3 text-[15px] focus:border-ink focus:outline-none"
                      />
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <TextField
        label="Maximálne hodín za event"
        type="number"
        inputMode="numeric"
        value={maxHours}
        onChange={(e) => setMaxHours(e.target.value)}
        hint="Nad tento limit ťa systém nepridelí."
      />

      <Button
        className="self-start"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await updateOwnAvailability({
              days: Object.entries(days).map(([day, times]) => ({ day, ...times })),
              maxHours: maxHours || undefined,
            });
            if (result.ok) {
              toast.success(result.message ?? "Uložené.");
              router.refresh();
            } else toast.error(result.message);
          })
        }
      >
        Uložiť dostupnosť
      </Button>
    </div>
  );
}

export function ExportDataButton() {
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await exportOwnData();
          if (!result.ok || !result.data) {
            toast.error(result.ok ? "Export je prázdny." : result.message);
            return;
          }
          const blob = new Blob([result.data.json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `crew-moje-udaje-${new Date().toISOString().slice(0, 10)}.json`;
          link.click();
          URL.revokeObjectURL(url);
          toast.success("Súbor s tvojimi údajmi je stiahnutý.");
        })
      }
    >
      Stiahnuť moje údaje
    </Button>
  );
}
