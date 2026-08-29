"use client";

import { RESTAURANT } from "@/lib/config";
import type { FieldErrors } from "@/lib/validation";
import type { CustomerDetails } from "@/lib/types";
import { TextAreaField, TextField } from "@/components/ui/Field";

interface DeliveryFormProps {
  customer: CustomerDetails;
  errors: FieldErrors;
  onChange: <K extends keyof CustomerDetails>(field: K, value: CustomerDetails[K]) => void;
}

export function DeliveryForm({ customer, errors, onChange }: DeliveryFormProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-[2fr_1fr]">
        <TextField
          id="street"
          label="Ulica"
          required
          autoComplete="address-line1"
          placeholder="Hlavná"
          value={customer.street ?? ""}
          onChange={(e) => onChange("street", e.target.value)}
          error={errors.street}
        />
        <TextField
          id="houseNumber"
          label="Číslo domu"
          required
          autoComplete="address-line2"
          placeholder="128"
          value={customer.houseNumber ?? ""}
          onChange={(e) => onChange("houseNumber", e.target.value)}
          error={errors.houseNumber}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-[2fr_1fr]">
        <TextField
          id="city"
          label="Mesto / obec"
          required
          autoComplete="address-level2"
          placeholder="Preseľany"
          value={customer.city ?? ""}
          onChange={(e) => onChange("city", e.target.value)}
          error={errors.city}
          hint={`Doručujeme do: ${RESTAURANT.deliveryZones.join(", ")}`}
        />
        <TextField
          id="postalCode"
          label="PSČ"
          required
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="956 12"
          value={customer.postalCode ?? ""}
          onChange={(e) => onChange("postalCode", e.target.value)}
          error={errors.postalCode}
        />
      </div>

      <TextAreaField
        id="delivery-note"
        label="Poznámka pre kuriéra"
        placeholder="napr. 2. poschodie, zvonček Novák, nechať pri dverách"
        maxLength={300}
        value={customer.note ?? ""}
        onChange={(e) => onChange("note", e.target.value)}
      />
    </div>
  );
}
