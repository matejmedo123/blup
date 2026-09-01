import { z } from "zod";

import { CHECK_IN_METHODS, SHIFT_STATUSES } from "@/db/enums";

import { optionalText, uuidSchema } from "./common";

export const positionSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(2, "Zadaj názov pozície.").max(80, "Názov je príliš dlhý."),
  description: optionalText(600),
  hourlyRate: z.coerce
    .number()
    .min(0, "Sadzba nemôže byť záporná.")
    .max(1000, "Skontroluj hodinovú sadzbu."),
  capacity: z.coerce.number().int().min(0).max(1000).default(0),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Zadaj farbu v tvare #RRGGBB.")
    .default("#111111"),
  requiredSkills: z.array(z.string().trim().max(60)).max(12).default([]),
  active: z.boolean().default(true),
});

export type PositionInput = z.infer<typeof positionSchema>;

export const shiftSchema = z
  .object({
    id: uuidSchema.optional(),
    positionId: uuidSchema,
    title: z.string().trim().max(80).optional().or(z.literal("")),
    /** Lokálny čas eventu z `<input type="datetime-local">`. */
    startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Zadaj dátum a čas začiatku."),
    endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Zadaj dátum a čas konca."),
    location: z.string().trim().max(160).optional().or(z.literal("")),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    capacity: z.coerce.number().int().min(1, "Kapacita musí byť aspoň 1.").max(500),
    hourlyRate: z.coerce.number().min(0).max(1000).optional(),
    status: z.enum(SHIFT_STATUSES).default("draft"),
    checkInMethod: z.enum(CHECK_IN_METHODS).default("manual"),
    geofenceRadiusM: z.coerce.number().int().min(20).max(5000).default(150),
    coordinatorId: uuidSchema.optional().or(z.literal("")),
    instructions: optionalText(2000),
    dressCode: optionalText(400),
    showColleagues: z.boolean().default(true),
  })
  .refine((v) => v.endsAt > v.startsAt, {
    message: "Koniec smeny musí byť neskôr ako začiatok.",
    path: ["endsAt"],
  })
  .refine(
    (v) => {
      if (v.checkInMethod !== "geofence" && v.checkInMethod !== "qr_geofence") return true;
      return v.lat != null && v.lng != null;
    },
    { message: "Pri kontrole polohy musíš zadať súradnice miesta.", path: ["lat"] },
  );

export type ShiftInput = z.infer<typeof shiftSchema>;

export const assignmentSchema = z.object({
  shiftId: uuidSchema,
  userIds: z.array(uuidSchema).min(1, "Vyber aspoň jedného človeka."),
  note: optionalText(400),
});

export const autoAssignSchema = z.object({
  shiftIds: z.array(uuidSchema).min(1, "Vyber aspoň jednu smenu."),
  /** Bez potvrdenia sa vráti len návrh — admin ho musí schváliť (§17). */
  confirm: z.boolean().default(false),
});
