"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createEvent } from "@/app/actions/admin-settings";
import { switchEvent } from "@/app/actions/events";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function NewEventForm() {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState({
    name: "",
    slug: "",
    startDate: "",
    endDate: "",
    location: "",
    timezone: "Europe/Bratislava",
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null}

      <TextField
        label="Názov eventu"
        required
        value={values.name}
        onChange={(e) =>
          setValues((current) => ({
            ...current,
            name: e.target.value,
            slug: slugTouched ? current.slug : slugify(e.target.value),
          }))
        }
        error={errors.name}
        placeholder="Grape Festival 2026"
      />
      <TextField
        label="Adresa (slug)"
        required
        value={values.slug}
        onChange={(e) => {
          setSlugTouched(true);
          setValues({ ...values, slug: e.target.value });
        }}
        error={errors.slug}
        hint="Malé písmená, čísla a pomlčky."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Začiatok"
          type="date"
          required
          value={values.startDate}
          onChange={(e) => setValues({ ...values, startDate: e.target.value })}
          error={errors.startDate}
        />
        <TextField
          label="Koniec"
          type="date"
          required
          value={values.endDate}
          onChange={(e) => setValues({ ...values, endDate: e.target.value })}
          error={errors.endDate}
        />
      </div>
      <TextField
        label="Miesto"
        value={values.location}
        onChange={(e) => setValues({ ...values, location: e.target.value })}
        error={errors.location}
      />
      <TextField
        label="Časové pásmo"
        required
        value={values.timezone}
        onChange={(e) => setValues({ ...values, timezone: e.target.value })}
        error={errors.timezone}
      />

      <InlineNotice tone="info">
        Nový event vznikne ako koncept — verejné prihlášky sa naň nedajú podať, kým ho neaktivuješ
        v nastaveniach.
      </InlineNotice>

      <Button
        className="self-start"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            setFormError(null);
            setErrors({});
            const result = await createEvent(values);
            if (result.ok && result.data) {
              toast.success(result.message ?? "Event je vytvorený.");
              await switchEvent(result.data.id);
              router.push("/admin/settings");
              router.refresh();
            } else if (!result.ok) {
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
        Vytvoriť event
      </Button>
    </div>
  );
}
