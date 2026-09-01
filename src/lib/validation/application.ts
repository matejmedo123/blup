import { z } from "zod";

import { POSITION_KEYS, VOLUNTEER_PREFERENCES, WORK_TYPES } from "@/db/enums";

import {
  birthYearSchema,
  citySchema,
  emailSchema,
  isoDateSchema,
  nameSchema,
  optionalText,
  passwordSchema,
  phoneSchema,
  timeSchema,
} from "./common";

/* ------------------------------------------------- brigádnik: registrácia */

export const stepPersonalSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
  birthYear: birthYearSchema,
  city: citySchema,
  avatarUrl: z.string().trim().url("Zadaj platnú adresu obrázka.").optional().or(z.literal("")),
  password: passwordSchema,
});

export const experienceSchema = z
  .object({
    positionLabel: z.string().trim().min(2, "Zadaj pozíciu.").max(80),
    company: z.string().trim().min(2, "Zadaj firmu alebo event.").max(120),
    workType: z.enum(WORK_TYPES),
    dateFrom: isoDateSchema,
    dateTo: z.union([isoDateSchema, z.literal("")]).optional(),
    description: optionalText(600),
  })
  .refine((v) => !v.dateTo || v.dateTo >= v.dateFrom, {
    message: "Dátum do nemôže byť skôr ako dátum od.",
    path: ["dateTo"],
  });

/** Rule: prihláška musí obsahovať aspoň jednu pracovnú skúsenosť (§5, krok 2). */
export const stepExperienceSchema = z.object({
  experiences: z
    .array(experienceSchema)
    .min(1, "Pridaj aspoň jednu pracovnú skúsenosť.")
    .max(10, "Maximálne 10 skúseností."),
});

export const stepPositionsSchema = z.object({
  positions: z
    .array(z.enum(POSITION_KEYS))
    .min(1, "Vyber aspoň jednu pozíciu, o ktorú máš záujem.")
    .max(POSITION_KEYS.length),
});

export const availabilityDaySchema = z
  .object({
    day: isoDateSchema,
    timeFrom: timeSchema,
    timeTo: timeSchema,
  })
  .refine((v) => v.timeTo > v.timeFrom, {
    message: "Koniec musí byť neskôr ako začiatok.",
    path: ["timeTo"],
  });

export const stepAvailabilitySchema = z.object({
  days: z.array(availabilityDaySchema).min(1, "Označ aspoň jeden deň, kedy môžeš pracovať."),
  maxHours: z.coerce
    .number()
    .int()
    .min(4, "Zadaj aspoň 4 hodiny.")
    .max(120, "To je príliš veľa hodín.")
    .optional(),
  note: optionalText(400),
});

export const QUESTION_KEYS = [
  "driving_licence",
  "english",
  "german",
  "event_experience",
  "night_shifts",
  "own_transport",
] as const;

export const QUESTIONS: { key: (typeof QUESTION_KEYS)[number]; label: string }[] = [
  { key: "driving_licence", label: "Máš vodičský preukaz?" },
  { key: "english", label: "Dohovoríš sa po anglicky?" },
  { key: "german", label: "Dohovoríš sa po nemecky?" },
  { key: "event_experience", label: "Máš skúsenosť s prácou na evente?" },
  { key: "night_shifts", label: "Môžeš pracovať v noci?" },
  { key: "own_transport", label: "Máš vlastnú dopravu?" },
];

export const stepAnswersSchema = z.object({
  answers: z.record(z.enum(QUESTION_KEYS), z.boolean()),
  motivation: optionalText(800),
});

export const stepConsentSchema = z.object({
  gdpr: z.literal(true, { message: "Bez súhlasu so spracovaním údajov nevieme prihlášku prijať." }),
  terms: z.literal(true, { message: "Musíš súhlasiť s podmienkami." }),
});

/** Kompletná prihláška brigádnika — server validuje vždy celý objekt naraz. */
export const brigadeApplicationSchema = z.object({
  ...stepPersonalSchema.shape,
  ...stepExperienceSchema.shape,
  ...stepPositionsSchema.shape,
  ...stepAvailabilitySchema.shape,
  ...stepAnswersSchema.shape,
  ...stepConsentSchema.shape,
  eventId: z.uuid().optional(),
});

export type BrigadeApplicationInput = z.infer<typeof brigadeApplicationSchema>;
export type ExperienceInput = z.infer<typeof experienceSchema>;

/* ------------------------------------------------------------ dobrovoľník */

export const volunteerApplicationSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
  city: citySchema.optional().or(z.literal("")),
  birthYear: birthYearSchema.optional(),
  preferences: z
    .array(z.enum(VOLUNTEER_PREFERENCES))
    .min(1, "Vyber aspoň jednu oblasť, v ktorej chceš pomôcť."),
  availability: z
    .array(z.object({ day: isoDateSchema, from: timeSchema, to: timeSchema }))
    .min(1, "Označ aspoň jeden deň, kedy môžeš prísť."),
  note: optionalText(800),
  gdpr: z.literal(true, { message: "Bez súhlasu so spracovaním údajov nevieme prihlášku prijať." }),
  eventId: z.uuid().optional(),
});

export type VolunteerApplicationInput = z.infer<typeof volunteerApplicationSchema>;

/* --------------------------------------------------------------- stánkar */

export const vendorApplicationSchema = z.object({
  contactName: nameSchema,
  companyName: z.string().trim().max(160).optional().or(z.literal("")),
  ico: z
    .string()
    .trim()
    .regex(/^\d{6,12}$/, "IČO má 6 až 12 číslic.")
    .optional()
    .or(z.literal("")),
  email: emailSchema,
  phone: phoneSchema,
  website: z.string().trim().url("Zadaj platnú adresu webu.").optional().or(z.literal("")),
  instagram: z.string().trim().max(120).optional().or(z.literal("")),
  facebook: z.string().trim().max(120).optional().or(z.literal("")),
  standType: z.enum(["food_truck", "stand", "tent", "trailer", "table", "other"]),
  assortment: z
    .array(
      z.enum([
        "food",
        "drinks",
        "crafts",
        "clothing",
        "facepainting",
        "rides",
        "tattoo",
        "handmade",
        "services",
        "other",
      ]),
    )
    .min(1, "Vyber aspoň jednu kategóriu sortimentu."),
  assortmentDetail: optionalText(600),
  widthM: z.coerce.number().positive("Zadaj šírku v metroch.").max(50, "Skontroluj rozmer."),
  depthM: z.coerce.number().positive("Zadaj hĺbku v metroch.").max(50, "Skontroluj rozmer."),
  needsElectricity: z.boolean(),
  powerKw: z.coerce.number().min(0).max(200).optional(),
  needsWater: z.boolean(),
  needsWaste: z.boolean(),
  placementRequest: optionalText(600),
  note: optionalText(800),
  attachments: z
    .array(z.object({ name: z.string().max(200), url: z.string().url(), size: z.number().optional() }))
    .max(5, "Najviac 5 príloh.")
    .optional(),
  gdpr: z.literal(true, { message: "Bez súhlasu so spracovaním údajov nevieme prihlášku prijať." }),
  eventId: z.uuid().optional(),
});

export type VendorApplicationInput = z.infer<typeof vendorApplicationSchema>;
