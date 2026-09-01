import { z } from "zod";

/** Slovenské / medzinárodné telefónne číslo. */
export const phoneSchema = z
  .string()
  .trim()
  .min(9, "Zadaj platné telefónne číslo.")
  .max(20, "Telefónne číslo je príliš dlhé.")
  .regex(/^\+?[0-9 ()/-]{9,20}$/, "Zadaj platné telefónne číslo, napríklad +421 900 123 456.");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Zadaj e-mail.")
  .max(254, "E-mail je príliš dlhý.")
  .pipe(z.email("Zadaj platný e-mail, napríklad meno@domena.sk."));

export const passwordSchema = z
  .string()
  .min(10, "Heslo musí mať aspoň 10 znakov.")
  .max(200, "Heslo je príliš dlhé.")
  .refine((v) => /[a-zA-ZáäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ]/.test(v), {
    message: "Heslo musí obsahovať aspoň jedno písmeno.",
  })
  .refine((v) => /[0-9]/.test(v), { message: "Heslo musí obsahovať aspoň jednu číslicu." });

export const nameSchema = z
  .string()
  .trim()
  .min(2, "Zadaj aspoň 2 znaky.")
  .max(80, "Príliš dlhý text.");

export const citySchema = z.string().trim().min(2, "Zadaj mesto.").max(80, "Príliš dlhý názov mesta.");

const CURRENT_YEAR = new Date().getFullYear();

export const birthYearSchema = z.coerce
  .number()
  .int("Zadaj rok narodenia ako číslo.")
  .min(CURRENT_YEAR - 90, "Skontroluj rok narodenia.")
  .max(CURRENT_YEAR - 15, "Na brigádu musíš mať aspoň 15 rokov.");

export const uuidSchema = z.uuid("Neplatný identifikátor.");

export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max, `Text môže mať najviac ${max} znakov.`)
    .optional()
    .transform((v) => (v ? v : undefined));

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Zadaj dátum v tvare RRRR-MM-DD.");

export const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, "Zadaj čas v tvare HH:MM.");

/** Prevedie ZodError na `{ pole: [hlášky] }` pre `ActionResult.fieldErrors`. */
export function fieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Prvá hláška pre každé pole — na rýchle zobrazenie pod inputom. */
export function firstErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
