"use client";

import { useState, useTransition } from "react";

import { submitVendorApplication } from "@/app/actions/applications";
import { SubmittedState } from "@/components/forms/FormShell";
import { Button, ButtonLink } from "@/components/ui/Button";
import {
  CheckboxField,
  ChipToggle,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/ui/Field";
import { IconPlus, IconTrash } from "@/components/ui/Icons";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { VENDOR_ASSORTMENTS, VENDOR_STAND_TYPES } from "@/db/enums";
import { VENDOR_ASSORTMENT_LABELS, VENDOR_STAND_TYPE_LABELS } from "@/lib/labels";

type Attachment = { name: string; url: string };

export function VendorForm() {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [assortment, setAssortment] = useState<string[]>([]);
  const [needsElectricity, setNeedsElectricity] = useState(false);
  const [needsWater, setNeedsWater] = useState(false);
  const [needsWaste, setNeedsWaste] = useState(false);
  const [gdpr, setGdpr] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  function onSubmit(formData: FormData) {
    setError(null);
    setErrors({});
    startTransition(async () => {
      const result = await submitVendorApplication({
        contactName: String(formData.get("contactName") ?? ""),
        companyName: String(formData.get("companyName") ?? ""),
        ico: String(formData.get("ico") ?? ""),
        email: String(formData.get("email") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        website: String(formData.get("website") ?? ""),
        instagram: String(formData.get("instagram") ?? ""),
        facebook: String(formData.get("facebook") ?? ""),
        standType: String(formData.get("standType") ?? "stand"),
        assortment,
        assortmentDetail: String(formData.get("assortmentDetail") ?? "") || undefined,
        widthM: String(formData.get("widthM") ?? ""),
        depthM: String(formData.get("depthM") ?? ""),
        needsElectricity,
        powerKw: needsElectricity && formData.get("powerKw") ? String(formData.get("powerKw")) : undefined,
        needsWater,
        needsWaste,
        placementRequest: String(formData.get("placementRequest") ?? "") || undefined,
        note: String(formData.get("note") ?? "") || undefined,
        attachments: attachments.filter((a) => a.url && a.name),
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
      <SubmittedState title="Prihlášku máme." action={<ButtonLink href="/">Späť na úvod</ButtonLink>}>
        <p>
          Produkčný tím si ju prejde a ozve sa ti e-mailom s rozhodnutím, miestom a technickými
          podmienkami.
        </p>
      </SubmittedState>
    );
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-8">
      {error ? <InlineNotice tone="danger" title="Skontroluj formulár">{error}</InlineNotice> : null}

      <div>
        <h2 className="text-[22px] font-bold tracking-[-0.03em]">Kontakt</h2>
        <div className="mt-5 flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Meno a priezvisko" name="contactName" required error={errors.contactName} />
            <TextField label="Názov firmy / značky" name="companyName" error={errors.companyName} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="IČO"
              name="ico"
              inputMode="numeric"
              placeholder="12345678"
              error={errors.ico}
              hint="Nepovinné, ak predávaš ako fyzická osoba."
            />
            <TextField label="Telefón" name="phone" type="tel" required placeholder="+421 900 123 456" error={errors.phone} />
          </div>
          <TextField label="E-mail" name="email" type="email" required error={errors.email} />
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField label="Web" name="website" type="url" placeholder="https://…" error={errors.website} />
            <TextField label="Instagram" name="instagram" placeholder="@znacka" error={errors.instagram} />
            <TextField label="Facebook" name="facebook" placeholder="facebook.com/…" error={errors.facebook} />
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-[22px] font-bold tracking-[-0.03em]">Čo predávaš</h2>
        <div className="mt-5 flex flex-col gap-4">
          <div>
            <p className="mb-2.5 text-sm font-semibold text-ink">Sortiment</p>
            <div className="flex flex-wrap gap-2">
              {VENDOR_ASSORTMENTS.map((key) => (
                <ChipToggle
                  key={key}
                  label={VENDOR_ASSORTMENT_LABELS[key]}
                  checked={assortment.includes(key)}
                  onChange={(checked) =>
                    setAssortment((current) =>
                      checked ? [...current, key] : current.filter((a) => a !== key),
                    )
                  }
                />
              ))}
            </div>
            {errors.assortment ? (
              <p className="mt-2 text-[13px] font-semibold text-bad-fg">{errors.assortment}</p>
            ) : null}
          </div>
          <TextAreaField
            label="Popíš sortiment"
            name="assortmentDetail"
            rows={3}
            placeholder="Napríklad: burgery, hranolky, domáca limonáda."
            error={errors.assortmentDetail}
          />
        </div>
      </div>

      <div>
        <h2 className="text-[22px] font-bold tracking-[-0.03em]">Stánok a technika</h2>
        <div className="mt-5 flex flex-col gap-4">
          <SelectField label="Typ stánku" name="standType" required error={errors.standType}>
            {VENDOR_STAND_TYPES.map((type) => (
              <option key={type} value={type}>
                {VENDOR_STAND_TYPE_LABELS[type]}
              </option>
            ))}
          </SelectField>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Šírka (m)"
              name="widthM"
              type="number"
              step="0.1"
              required
              inputMode="decimal"
              placeholder="3"
              error={errors.widthM}
            />
            <TextField
              label="Hĺbka (m)"
              name="depthM"
              type="number"
              step="0.1"
              required
              inputMode="decimal"
              placeholder="2"
              error={errors.depthM}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <CheckboxField
              label="Elektrická prípojka"
              checked={needsElectricity}
              onChange={(e) => setNeedsElectricity(e.target.checked)}
            />
            <CheckboxField
              label="Voda"
              checked={needsWater}
              onChange={(e) => setNeedsWater(e.target.checked)}
            />
            <CheckboxField
              label="Odpad"
              checked={needsWaste}
              onChange={(e) => setNeedsWaste(e.target.checked)}
            />
          </div>

          {needsElectricity ? (
            <TextField
              label="Potrebný príkon (kW)"
              name="powerKw"
              type="number"
              step="0.1"
              inputMode="decimal"
              placeholder="3.5"
              error={errors.powerKw}
              hint="Ak nevieš presne, odhadni. Podľa toho plánujeme rozvody."
            />
          ) : null}

          <TextAreaField
            label="Požiadavky na miesto"
            name="placementRequest"
            rows={3}
            placeholder="Napríklad: blízko hlavnej scény, potrebujeme prístup autom do 10:00."
            error={errors.placementRequest}
          />
        </div>
      </div>

      <div>
        <h2 className="text-[22px] font-bold tracking-[-0.03em]">Prílohy</h2>
        <p className="mt-1.5 text-[15px] text-muted">
          Odkazy na fotky stánku, menu alebo certifikáty. Najviac päť.
        </p>
        <div className="mt-5 flex flex-col gap-3">
          {attachments.map((attachment, index) => (
            <div key={index} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
              <TextField
                label={index === 0 ? "Názov" : undefined}
                aria-label="Názov prílohy"
                value={attachment.name}
                onChange={(e) =>
                  setAttachments((current) =>
                    current.map((a, i) => (i === index ? { ...a, name: e.target.value } : a)),
                  )
                }
                placeholder="Foto stánku"
              />
              <TextField
                label={index === 0 ? "Odkaz" : undefined}
                aria-label="Odkaz na prílohu"
                type="url"
                value={attachment.url}
                onChange={(e) =>
                  setAttachments((current) =>
                    current.map((a, i) => (i === index ? { ...a, url: e.target.value } : a)),
                  )
                }
                placeholder="https://…"
              />
              <button
                type="button"
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                className={
                  "touch flex cursor-pointer items-center justify-center rounded-12 border border-line-strong px-3 text-muted hover:bg-hover hover:text-ink " +
                  (index === 0 ? "sm:mt-[26px]" : "")
                }
                aria-label="Odstrániť prílohu"
              >
                <IconTrash width={18} height={18} />
              </button>
            </div>
          ))}
          {attachments.length < 5 ? (
            <Button
              type="button"
              variant="outline"
              icon={<IconPlus width={18} height={18} />}
              onClick={() => setAttachments((current) => [...current, { name: "", url: "" }])}
              className="self-start"
            >
              Pridať prílohu
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <TextAreaField
          label="Poznámka"
          name="note"
          rows={4}
          placeholder="Čokoľvek ďalšie, čo by sme mali vedieť."
          error={errors.note}
        />
        <CheckboxField
          label="Súhlasím so spracovaním osobných údajov"
          hint="Údaje použijeme len na posúdenie prihlášky a organizáciu stánkov."
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
