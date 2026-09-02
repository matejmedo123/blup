"use client";

import { useMemo } from "react";
import { RESTAURANT } from "@/lib/config";
import { useMenu } from "@/context/MenuContext";
import { buildPickupSlots, type FieldErrors } from "@/lib/validation";
import type { CustomerDetails } from "@/lib/types";
import { SelectField, TextAreaField } from "@/components/ui/Field";
import { PinIcon } from "@/components/ui/Icons";

interface PickupFormProps {
  customer: CustomerDetails;
  errors: FieldErrors;
  onChange: <K extends keyof CustomerDetails>(field: K, value: CustomerDetails[K]) => void;
}

export function PickupForm({ customer, errors, onChange }: PickupFormProps) {
  const { settings } = useMenu();
  const slots = useMemo(() => buildPickupSlots(), []);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-4 rounded-xl border border-ink/10 bg-white p-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-burgundy/10 text-burgundy">
          <PinIcon className="h-5 w-5" />
        </span>
        <div>
          <p className="eyebrow text-ink/45">Vyzdvihnutie na adrese</p>
          <p className="mt-1.5 font-display text-[1.25rem] leading-tight text-ink">
            {RESTAURANT.address.street}, {RESTAURANT.address.city}
          </p>
          <p className="mt-1 text-[0.82rem] text-ink/55">
            Objednávku ti pripravíme za {settings.prepTimePickup}.
          </p>
        </div>
      </div>

      <SelectField
        id="pickupTime"
        label="Čas odberu"
        required
        options={slots}
        placeholder="Vyber čas odberu"
        value={customer.pickupTime ?? ""}
        onChange={(e) => onChange("pickupTime", e.target.value)}
        error={errors.pickupTime}
      />

      <TextAreaField
        id="pickup-note"
        label="Poznámka k objednávke"
        placeholder="napr. prídem o 5 minút neskôr"
        maxLength={300}
        value={customer.note ?? ""}
        onChange={(e) => onChange("note", e.target.value)}
      />
    </div>
  );
}
