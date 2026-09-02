import type { CustomerDetails, OrderType } from "./types";

export type FieldErrors = Partial<Record<keyof CustomerDetails | "terms", string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
// SK/CZ mobil aj pevná linka, s medzerami alebo bez
const PHONE_RE = /^(\+4\d{2}|0)[\s./-]?\d{2,3}([\s./-]?\d{2,3}){2,3}$/;
const POSTAL_RE = /^\d{3}\s?\d{2}$/;

export interface ValidateInput {
  customer: CustomerDetails;
  orderType: OrderType;
  termsAccepted: boolean;
}

export function validateCheckout({
  customer,
  orderType,
  termsAccepted,
}: ValidateInput): FieldErrors {
  const errors: FieldErrors = {};

  if (!customer.firstName.trim()) {
    errors.firstName = "Zadajte meno.";
  } else if (customer.firstName.trim().length < 2) {
    errors.firstName = "Meno musí mať aspoň 2 znaky.";
  }

  if (!customer.lastName.trim()) {
    errors.lastName = "Zadajte priezvisko.";
  } else if (customer.lastName.trim().length < 2) {
    errors.lastName = "Priezvisko musí mať aspoň 2 znaky.";
  }

  if (!customer.phone.trim()) {
    errors.phone = "Zadajte telefónne číslo.";
  } else if (!PHONE_RE.test(customer.phone.trim())) {
    errors.phone = "Zadajte platné číslo, napr. 0948 238 346.";
  }

  if (!customer.email.trim()) {
    errors.email = "Zadajte e-mail.";
  } else if (!EMAIL_RE.test(customer.email.trim())) {
    errors.email = "Zadajte platnú e-mailovú adresu.";
  }

  if (orderType === "pickup") {
    if (!customer.pickupTime?.trim()) {
      errors.pickupTime = "Vyberte čas odberu.";
    }
  } else {
    if (!customer.street?.trim()) {
      errors.street = "Zadajte ulicu.";
    }
    if (!customer.houseNumber?.trim()) {
      errors.houseNumber = "Zadajte číslo domu.";
    }
    if (!customer.city?.trim()) {
      errors.city = "Zadajte mesto alebo obec.";
    }
    if (!customer.postalCode?.trim()) {
      errors.postalCode = "Zadajte PSČ.";
    } else if (!POSTAL_RE.test(customer.postalCode.trim())) {
      errors.postalCode = "PSČ musí mať 5 číslic, napr. 956 12.";
    }
  }

  if (!termsAccepted) {
    errors.terms = "Pre pokračovanie musíte súhlasiť s obchodnými podmienkami.";
  }

  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Vygeneruje časy odberu v 15-minútových krokoch od najbližšieho možného. */
export function buildPickupSlots(now = new Date(), count = 12): string[] {
  const slots: string[] = ["Čo najskôr (15 — 20 min)"];
  const start = new Date(now.getTime() + 20 * 60 * 1000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  for (let i = 0; i < count; i++) {
    const t = new Date(start.getTime() + i * 15 * 60 * 1000);
    slots.push(
      `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`,
    );
  }
  return slots;
}
