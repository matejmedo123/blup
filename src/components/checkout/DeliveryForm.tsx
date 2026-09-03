"use client";

import { RESTAURANT } from "@/lib/config";
import { useMenu } from "@/context/MenuContext";
import { formatPrice } from "@/lib/format";
import type { FieldErrors } from "@/lib/validation";
import type { CustomerDetails } from "@/lib/types";
import { SelectField, TextAreaField, TextField } from "@/components/ui/Field";

interface DeliveryFormProps {
  customer: CustomerDetails;
  errors: FieldErrors;
  onChange: <K extends keyof CustomerDetails>(field: K, value: CustomerDetails[K]) => void;
}

export function DeliveryForm({ customer, errors, onChange }: DeliveryFormProps) {
  const { zones } = useMenu();

  /**
   * Keď má prevádzka nastavené zóny, obec sa vyberá zo zoznamu — zákazník
   * tak vidí poplatok dopredu a nestane sa, že objednávku odošle a až
   * server mu povie, že tam nevozíme.
   */
  const zone = zones.find((z) => z.name === customer.city) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-[2fr_1fr]">
        <TextField
          id="street"
          label="Ulica"
          required
          autoComplete="address-line1"
          placeholder="Koniarovce"
          value={customer.street ?? ""}
          onChange={(e) => onChange("street", e.target.value)}
          error={errors.street}
        />
        <TextField
          id="houseNumber"
          label="Číslo domu"
          required
          autoComplete="address-line2"
          placeholder="290"
          value={customer.houseNumber ?? ""}
          onChange={(e) => onChange("houseNumber", e.target.value)}
          error={errors.houseNumber}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-[2fr_1fr]">
        {zones.length > 0 ? (
          <SelectField
            id="city"
            label="Mesto / obec"
            required
            value={customer.city ?? ""}
            onChange={(e) => onChange("city", e.target.value)}
            error={errors.city}
            hint={
              zone
                ? zone.fee === 0
                  ? `Doručenie zdarma · približne ${zone.etaMinutes} min`
                  : `Doručenie ${formatPrice(zone.fee)}${
                      zone.freeFrom !== null ? ` · zdarma od ${formatPrice(zone.freeFrom)}` : ""
                    } · približne ${zone.etaMinutes} min`
                : "Vyber si obec zo zoznamu"
            }
            options={[
              { value: "", label: "— vyber obec —" },
              ...zones.map((z) => ({
                value: z.name,
                label: z.fee === 0 ? `${z.name} — zdarma` : `${z.name} — ${formatPrice(z.fee)}`,
              })),
            ]}
          />
        ) : (
          <TextField
            id="city"
            label="Mesto / obec"
            required
            autoComplete="address-level2"
            placeholder="Koniarovce"
            value={customer.city ?? ""}
            onChange={(e) => onChange("city", e.target.value)}
            error={errors.city}
            hint={`Doručujeme do: ${RESTAURANT.deliveryZones.join(", ")}`}
          />
        )}
        <TextField
          id="postalCode"
          label="PSČ"
          required
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="956 13"
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
