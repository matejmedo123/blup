"use client";

import { useState, useTransition } from "react";

import { submitVolunteerApplication } from "@/app/actions/applications";
import { SubmittedState } from "@/components/forms/FormShell";
import { Button, ButtonLink } from "@/components/ui/Button";
import { CheckboxField, ChipToggle, TextAreaField, TextField } from "@/components/ui/Field";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { VOLUNTEER_PREFERENCES } from "@/db/enums";
import { cn } from "@/lib/cn";
import { formatDateWithWeekday } from "@/lib/format";
import { VOLUNTEER_PREFERENCE_LABELS } from "@/lib/labels";

export function VolunteerForm({
  eventDays,
  timezone,
}: {
  eventDays: string[];
  timezone: string;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [preferences, setPreferences] = useState<string[]>([]);
  const [days, setDays] = useState<Record<string, { from: string; to: string }>>({});
  const [gdpr, setGdpr] = useState(false);

  function onSubmit(formData: FormData) {
    setError(null);
    setErrors({});
    startTransition(async () => {
      const result = await submitVolunteerApplication({
        firstName: String(formData.get("firstName") ?? ""),
        lastName: String(formData.get("lastName") ?? ""),
        email: String(formData.get("email") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        city: String(formData.get("city") ?? ""),
        birthYear: formData.get("birthYear") ? String(formData.get("birthYear")) : undefined,
        preferences,
        availability: Object.entries(days).map(([day, t]) => ({ day, from: t.from, to: t.to })),
        note: String(formData.get("note") ?? "") || undefined,
        gdpr,
      });

      if (!result.ok) {
        setError(result.message);
        if (result.fieldErrors) {
          setErrors(
            Object.fromEntries(Object.entries(result.fieldErrors).map(([k, v]) => [k, v[0]])),
          );
        }
        toast.error(result.message);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      toast.success("Prihlášku sme prijali.");
      setDone(true);
    });
  }

  if (done) {
    return (
      <SubmittedState
        title="Ďakujeme."
        action={<ButtonLink href="/">Späť na úvod</ButtonLink>}
      >
        <p>
          Prihlášku máme. Koordinátor dobrovoľníkov sa ti ozve e-mailom alebo telefonicky
          s konkrétnymi detailmi.
        </p>
      </SubmittedState>
    );
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-8">
      {error ? <InlineNotice tone="danger" title="Skontroluj formulár">{error}</InlineNotice> : null}

      <div>
        <h2 className="text-[22px] font-bold tracking-[-0.03em]">Kto si</h2>
        <div className="mt-5 flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Meno" name="firstName" required autoComplete="given-name" error={errors.firstName} />
            <TextField label="Priezvisko" name="lastName" required autoComplete="family-name" error={errors.lastName} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="E-mail" name="email" type="email" required autoComplete="email" error={errors.email} />
            <TextField
              label="Telefón"
              name="phone"
              type="tel"
              required
              autoComplete="tel"
              placeholder="+421 900 123 456"
              error={errors.phone}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Mesto" name="city" autoComplete="address-level2" error={errors.city} />
            <TextField
              label="Rok narodenia"
              name="birthYear"
              type="number"
              inputMode="numeric"
              placeholder="2001"
              error={errors.birthYear}
            />
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-[22px] font-bold tracking-[-0.03em]">Kde chceš pomôcť</h2>
        <p className="mt-1.5 text-[15px] text-muted">Vyber všetko, čo ti nevadí.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          {VOLUNTEER_PREFERENCES.map((key) => (
            <ChipToggle
              key={key}
              label={VOLUNTEER_PREFERENCE_LABELS[key]}
              checked={preferences.includes(key)}
              onChange={(checked) =>
                setPreferences((current) =>
                  checked ? [...current, key] : current.filter((p) => p !== key),
                )
              }
            />
          ))}
        </div>
        {errors.preferences ? (
          <p className="mt-2 text-[13px] font-semibold text-bad-fg">{errors.preferences}</p>
        ) : null}
      </div>

      <div>
        <h2 className="text-[22px] font-bold tracking-[-0.03em]">Kedy môžeš prísť</h2>
        <div className="mt-5 flex flex-col gap-2.5">
          {eventDays.map((day) => {
            const selected = day in days;
            return (
              <div
                key={day}
                className={cn(
                  "rounded-16 border p-3.5 transition-colors duration-150",
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
                        if (e.target.checked) next[day] = { from: "09:00", to: "20:00" };
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
                    {(["from", "to"] as const).map((bound) => (
                      <label key={bound} className="flex flex-col gap-1">
                        <span className="text-xs font-semibold text-muted">
                          {bound === "from" ? "Od" : "Do"}
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
        {errors.availability ? (
          <p className="mt-2 text-[13px] font-semibold text-bad-fg">{errors.availability}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <TextAreaField
          label="Poznámka"
          name="note"
          rows={4}
          placeholder="Čokoľvek, čo by sme mali vedieť."
          error={errors.note}
        />
        <CheckboxField
          label="Súhlasím so spracovaním osobných údajov"
          hint="Údaje použijeme len na organizáciu dobrovoľníkov na tomto evente."
          checked={gdpr}
          onChange={(e) => setGdpr(e.target.checked)}
          error={errors.gdpr}
        />
      </div>

      <div className="border-t border-line pt-6">
        <Button type="submit" loading={pending}>
          Odoslať prihlášku
        </Button>
      </div>
    </form>
  );
}
