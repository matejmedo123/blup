"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";

import { submitBrigadeApplication } from "@/app/actions/applications";
import { Button } from "@/components/ui/Button";
import { CheckboxField, ChipToggle, SelectField, TextAreaField, TextField } from "@/components/ui/Field";
import { IconPlus, IconTrash } from "@/components/ui/Icons";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { POSITION_KEYS, WORK_TYPES } from "@/db/enums";
import { cn } from "@/lib/cn";
import { formatDateWithWeekday } from "@/lib/format";
import { POSITION_KEY_LABELS, WORK_TYPE_LABELS } from "@/lib/labels";
import {
  QUESTIONS,
  stepAnswersSchema,
  stepAvailabilitySchema,
  stepConsentSchema,
  stepExperienceSchema,
  stepPersonalSchema,
  stepPositionsSchema,
  type ExperienceInput,
} from "@/lib/validation/application";
import { firstErrors } from "@/lib/validation/common";

import { FormSection, StepProgress } from "./FormShell";

const STEP_LABELS = [
  "Osobné údaje",
  "Skúsenosti",
  "Pozície",
  "Dostupnosť",
  "Doplňujúce otázky",
  "Súhlas",
];

type Draft = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  birthYear: string;
  city: string;
  avatarUrl: string;
  password: string;
  experiences: ExperienceInput[];
  positions: string[];
  days: Record<string, { timeFrom: string; timeTo: string }>;
  maxHours: string;
  note: string;
  answers: Record<string, boolean>;
  motivation: string;
  gdpr: boolean;
  terms: boolean;
};

const emptyExperience = (): ExperienceInput => ({
  positionLabel: "",
  company: "",
  workType: "helper",
  dateFrom: "",
  dateTo: "",
  description: undefined,
});

export function BrigadeRegistrationForm({
  eventDays,
  eventName,
  timezone,
}: {
  eventDays: string[];
  eventName: string;
  timezone: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    birthYear: "",
    city: "",
    avatarUrl: "",
    password: "",
    experiences: [emptyExperience()],
    positions: [],
    days: {},
    maxHours: "",
    note: "",
    answers: {},
    motivation: "",
    gdpr: false,
    terms: false,
  });

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  const selectedDays = useMemo(
    () =>
      Object.entries(draft.days).map(([day, times]) => ({
        day,
        timeFrom: times.timeFrom,
        timeTo: times.timeTo,
      })),
    [draft.days],
  );

  function validateStep(current: number): boolean {
    setFormError(null);
    const result = (() => {
      switch (current) {
        case 1:
          return stepPersonalSchema.safeParse({
            firstName: draft.firstName,
            lastName: draft.lastName,
            email: draft.email,
            phone: draft.phone,
            birthYear: draft.birthYear,
            city: draft.city,
            avatarUrl: draft.avatarUrl,
            password: draft.password,
          });
        case 2:
          return stepExperienceSchema.safeParse({ experiences: draft.experiences });
        case 3:
          return stepPositionsSchema.safeParse({ positions: draft.positions });
        case 4:
          return stepAvailabilitySchema.safeParse({
            days: selectedDays,
            maxHours: draft.maxHours || undefined,
            note: draft.note || undefined,
          });
        case 5:
          return stepAnswersSchema.safeParse({
            answers: draft.answers,
            motivation: draft.motivation || undefined,
          });
        case 6:
          return stepConsentSchema.safeParse({ gdpr: draft.gdpr, terms: draft.terms });
        default:
          return { success: true as const, data: {} };
      }
    })();

    if (!result.success) {
      const fieldMessages = firstErrors(result.error);
      setErrors(fieldMessages);
      const firstMessage = Object.values(fieldMessages)[0];
      if (firstMessage) setFormError(firstMessage);
      return false;
    }
    setErrors({});
    return true;
  }

  function goNext() {
    if (!validateStep(step)) return;
    setStep((s) => Math.min(STEP_LABELS.length, s + 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goBack() {
    setErrors({});
    setFormError(null);
    setStep((s) => Math.max(1, s - 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function submit() {
    if (!validateStep(6)) return;
    startTransition(async () => {
      const result = await submitBrigadeApplication({
        firstName: draft.firstName,
        lastName: draft.lastName,
        email: draft.email,
        phone: draft.phone,
        birthYear: draft.birthYear,
        city: draft.city,
        avatarUrl: draft.avatarUrl,
        password: draft.password,
        experiences: draft.experiences,
        positions: draft.positions,
        days: selectedDays,
        maxHours: draft.maxHours || undefined,
        note: draft.note || undefined,
        answers: draft.answers,
        motivation: draft.motivation || undefined,
        gdpr: draft.gdpr,
        terms: draft.terms,
      });

      if (!result.ok) {
        setFormError(result.message);
        if (result.fieldErrors) {
          setErrors(Object.fromEntries(Object.entries(result.fieldErrors).map(([k, v]) => [k, v[0]])));
          // Vráť používateľa na krok, kde chyba vznikla.
          const keys = Object.keys(result.fieldErrors);
          if (keys.some((k) => ["firstName", "lastName", "email", "phone", "birthYear", "city", "password"].includes(k))) {
            setStep(1);
          } else if (keys.some((k) => k.startsWith("experiences"))) setStep(2);
          else if (keys.some((k) => k.startsWith("positions"))) setStep(3);
          else if (keys.some((k) => k.startsWith("days") || k === "maxHours")) setStep(4);
        }
        toast.error(result.message);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      toast.success("Prihlášku sme prijali.");
      router.push("/brigada/registracia/hotovo");
    });
  }

  return (
    <div>
      <StepProgress step={step} total={STEP_LABELS.length} labels={STEP_LABELS} />

      {formError ? (
        <div className="mb-6">
          <InlineNotice tone="danger" title="Skontroluj formulár">
            {formError}
          </InlineNotice>
        </div>
      ) : null}

      {step === 1 ? (
        <FormSection title="Kto si" description="Toto vidí len koordinátor eventu.">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Meno"
              required
              autoComplete="given-name"
              value={draft.firstName}
              onChange={(e) => set("firstName", e.target.value)}
              error={errors.firstName}
            />
            <TextField
              label="Priezvisko"
              required
              autoComplete="family-name"
              value={draft.lastName}
              onChange={(e) => set("lastName", e.target.value)}
              error={errors.lastName}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="E-mail"
              type="email"
              required
              autoComplete="email"
              inputMode="email"
              value={draft.email}
              onChange={(e) => set("email", e.target.value)}
              error={errors.email}
              hint="Sem ti pošleme rozhodnutie a prihlasovacie údaje."
            />
            <TextField
              label="Telefón"
              type="tel"
              required
              autoComplete="tel"
              inputMode="tel"
              placeholder="+421 900 123 456"
              value={draft.phone}
              onChange={(e) => set("phone", e.target.value)}
              error={errors.phone}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Rok narodenia"
              type="number"
              required
              inputMode="numeric"
              placeholder="2001"
              value={draft.birthYear}
              onChange={(e) => set("birthYear", e.target.value)}
              error={errors.birthYear}
            />
            <TextField
              label="Mesto"
              required
              autoComplete="address-level2"
              value={draft.city}
              onChange={(e) => set("city", e.target.value)}
              error={errors.city}
            />
          </div>
          <TextField
            label="Profilová fotografia"
            type="url"
            placeholder="https://…"
            value={draft.avatarUrl}
            onChange={(e) => set("avatarUrl", e.target.value)}
            error={errors.avatarUrl}
            hint="Nepovinné. Pomáha koordinátorovi nájsť ťa v dave."
          />
          <TextField
            label="Heslo"
            type="password"
            required
            autoComplete="new-password"
            value={draft.password}
            onChange={(e) => set("password", e.target.value)}
            error={errors.password}
            hint="Aspoň 10 znakov, jedno písmeno a jedna číslica."
          />
        </FormSection>
      ) : null}

      {step === 2 ? (
        <FormSection
          title="Kde si už robil"
          description="Aspoň jedna skúsenosť je povinná. Nemusí byť z eventu — stačí čokoľvek, čo si robil."
        >
          {draft.experiences.map((experience, index) => (
            <div key={index} className="rounded-16 border border-line bg-hover p-4 sm:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="text-[15px] font-bold">Skúsenosť {index + 1}</h3>
                {draft.experiences.length > 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      set(
                        "experiences",
                        draft.experiences.filter((_, i) => i !== index),
                      )
                    }
                    className="touch inline-flex cursor-pointer items-center gap-1.5 rounded-10 px-2 text-[13px] font-semibold text-muted hover:bg-subtle hover:text-ink"
                  >
                    <IconTrash width={16} height={16} />
                    Odstrániť
                  </button>
                ) : null}
              </div>
              <div className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Pozícia"
                    required
                    placeholder="Barman"
                    value={experience.positionLabel}
                    onChange={(e) =>
                      set(
                        "experiences",
                        draft.experiences.map((x, i) =>
                          i === index ? { ...x, positionLabel: e.target.value } : x,
                        ),
                      )
                    }
                    error={errors[`experiences.${index}.positionLabel`]}
                  />
                  <TextField
                    label="Firma alebo event"
                    required
                    placeholder="Grape Festival"
                    value={experience.company}
                    onChange={(e) =>
                      set(
                        "experiences",
                        draft.experiences.map((x, i) =>
                          i === index ? { ...x, company: e.target.value } : x,
                        ),
                      )
                    }
                    error={errors[`experiences.${index}.company`]}
                  />
                </div>
                <SelectField
                  label="Typ práce"
                  value={experience.workType}
                  onChange={(e) =>
                    set(
                      "experiences",
                      draft.experiences.map((x, i) =>
                        i === index
                          ? { ...x, workType: e.target.value as ExperienceInput["workType"] }
                          : x,
                      ),
                    )
                  }
                >
                  {WORK_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {WORK_TYPE_LABELS[type]}
                    </option>
                  ))}
                </SelectField>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Od"
                    type="date"
                    required
                    value={experience.dateFrom}
                    onChange={(e) =>
                      set(
                        "experiences",
                        draft.experiences.map((x, i) =>
                          i === index ? { ...x, dateFrom: e.target.value } : x,
                        ),
                      )
                    }
                    error={errors[`experiences.${index}.dateFrom`]}
                  />
                  <TextField
                    label="Do"
                    type="date"
                    value={experience.dateTo ?? ""}
                    onChange={(e) =>
                      set(
                        "experiences",
                        draft.experiences.map((x, i) =>
                          i === index ? { ...x, dateTo: e.target.value } : x,
                        ),
                      )
                    }
                    error={errors[`experiences.${index}.dateTo`]}
                    hint="Nechaj prázdne, ak tam stále robíš."
                  />
                </div>
                <TextAreaField
                  label="Čo si tam robil"
                  rows={3}
                  value={experience.description ?? ""}
                  onChange={(e) =>
                    set(
                      "experiences",
                      draft.experiences.map((x, i) =>
                        i === index ? { ...x, description: e.target.value } : x,
                      ),
                    )
                  }
                  error={errors[`experiences.${index}.description`]}
                />
              </div>
            </div>
          ))}

          {draft.experiences.length < 10 ? (
            <Button
              type="button"
              variant="outline"
              icon={<IconPlus width={18} height={18} />}
              onClick={() => set("experiences", [...draft.experiences, emptyExperience()])}
              className="self-start"
            >
              Pridať ďalšiu skúsenosť
            </Button>
          ) : null}
        </FormSection>
      ) : null}

      {step === 3 ? (
        <FormSection
          title="Čo by si chcel robiť"
          description="Vyber všetko, čo ťa zaujíma. Neznamená to, že dostaneš práve túto pozíciu."
        >
          <div className="flex flex-wrap gap-2">
            {POSITION_KEYS.map((key) => (
              <ChipToggle
                key={key}
                label={POSITION_KEY_LABELS[key]}
                checked={draft.positions.includes(key)}
                onChange={(checked) =>
                  set(
                    "positions",
                    checked
                      ? [...draft.positions, key]
                      : draft.positions.filter((p) => p !== key),
                  )
                }
              />
            ))}
          </div>
          {errors.positions ? (
            <p className="text-[13px] font-semibold text-bad-fg">{errors.positions}</p>
          ) : null}
        </FormSection>
      ) : null}

      {step === 4 ? (
        <FormSection
          title="Kedy môžeš"
          description={`Označ dni, kedy si k dispozícii na ${eventName}. Časy môžeš upraviť.`}
        >
          <div className="flex flex-col gap-2.5">
            {eventDays.map((day) => {
              const selected = day in draft.days;
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
                        const next = { ...draft.days };
                        if (e.target.checked) next[day] = { timeFrom: "08:00", timeTo: "22:00" };
                        else delete next[day];
                        set("days", next);
                      }}
                    />
                    <span className="text-[15px] font-semibold capitalize">
                      {formatDateWithWeekday(`${day}T12:00:00Z`, timezone)}
                    </span>
                  </label>

                  {selected ? (
                    <div className="mt-3 grid grid-cols-2 gap-3 pl-8">
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-semibold text-muted">Od</span>
                        <input
                          type="time"
                          value={draft.days[day].timeFrom}
                          onChange={(e) =>
                            set("days", {
                              ...draft.days,
                              [day]: { ...draft.days[day], timeFrom: e.target.value },
                            })
                          }
                          className="h-11 rounded-12 border border-line-strong bg-surface px-3 text-[15px] focus:border-ink focus:outline-none"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-semibold text-muted">Do</span>
                        <input
                          type="time"
                          value={draft.days[day].timeTo}
                          onChange={(e) =>
                            set("days", {
                              ...draft.days,
                              [day]: { ...draft.days[day], timeTo: e.target.value },
                            })
                          }
                          className="h-11 rounded-12 border border-line-strong bg-surface px-3 text-[15px] focus:border-ink focus:outline-none"
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {errors.days ? (
            <p className="text-[13px] font-semibold text-bad-fg">{errors.days}</p>
          ) : null}

          <TextField
            label="Maximálne hodín za celý event"
            type="number"
            inputMode="numeric"
            placeholder="40"
            value={draft.maxHours}
            onChange={(e) => set("maxHours", e.target.value)}
            error={errors.maxHours}
            hint="Nepovinné. Nad tento limit ťa systém nepridelí."
          />
          <TextAreaField
            label="Preferencie a poznámky"
            rows={3}
            placeholder="Napríklad: radšej denné smeny, nemôžem v nedeľu poobede…"
            value={draft.note}
            onChange={(e) => set("note", e.target.value)}
            error={errors.note}
          />
        </FormSection>
      ) : null}

      {step === 5 ? (
        <FormSection
          title="Pár rýchlych otázok"
          description="Pomôžu nám priradiť ťa na správnu pozíciu."
        >
          <div className="flex flex-col gap-2.5">
            {QUESTIONS.map((question) => (
              <div
                key={question.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded-16 border border-line bg-hover p-4"
              >
                <span className="text-[15px] font-medium">{question.label}</span>
                <div className="flex gap-2" role="radiogroup" aria-label={question.label}>
                  {[
                    { value: true, label: "Áno" },
                    { value: false, label: "Nie" },
                  ].map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      role="radio"
                      aria-checked={draft.answers[question.key] === option.value}
                      onClick={() =>
                        set("answers", { ...draft.answers, [question.key]: option.value })
                      }
                      className={cn(
                        "touch cursor-pointer rounded-full px-5 text-[13px] font-semibold transition-colors duration-150",
                        draft.answers[question.key] === option.value
                          ? "bg-ink text-white"
                          : "border border-line-strong bg-surface text-muted hover:bg-subtle",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <TextAreaField
            label="Chceš niečo dodať?"
            rows={4}
            placeholder="Prečo chceš robiť práve na tomto evente?"
            value={draft.motivation}
            onChange={(e) => set("motivation", e.target.value)}
            error={errors.motivation}
          />
        </FormSection>
      ) : null}

      {step === 6 ? (
        <FormSection
          title="Posledný krok"
          description="Bez súhlasu prihlášku spracovať nevieme."
        >
          <CheckboxField
            label="Súhlasím so spracovaním osobných údajov"
            hint="Údaje použijeme len na nábor, plánovanie smien a výplatu. Kedykoľvek ich môžeš zmazať."
            checked={draft.gdpr}
            onChange={(e) => set("gdpr", e.target.checked)}
            error={errors.gdpr}
          />
          <CheckboxField
            label="Súhlasím s podmienkami spolupráce"
            hint="Potvrdzujem, že údaje sú pravdivé a smeny budem plniť podľa dohody."
            checked={draft.terms}
            onChange={(e) => set("terms", e.target.checked)}
            error={errors.terms}
          />
          <div className="rounded-16 bg-subtle-2 p-4 text-[14px] leading-[1.6] text-body">
            <p className="mb-1.5 font-semibold text-ink">Čo bude ďalej</p>
            <p>
              Prihlášku si prejde koordinátor. Rozhodnutie ti pošleme e-mailom, väčšinou do 2–3 dní.
              Po schválení sa prihlásiš a uvidíš svoje smeny.
            </p>
          </div>
        </FormSection>
      ) : null}

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-6">
        {step > 1 ? (
          <Button type="button" variant="outline" onClick={goBack} disabled={pending}>
            Späť
          </Button>
        ) : null}
        <div className="ml-auto flex gap-3">
          {step < STEP_LABELS.length ? (
            <Button type="button" onClick={goNext}>
              Pokračovať
            </Button>
          ) : (
            <Button type="button" onClick={submit} loading={pending}>
              Odoslať prihlášku
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
