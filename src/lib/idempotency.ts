import { readJSON, remove, STORAGE_KEYS, writeJSON } from "./storage";
import type { CartItem, CustomerDetails, OrderType, PaymentMethod } from "./types";

/**
 * Kľúč, ktorý bráni vzniku dvoch rovnakých objednávok.
 *
 * Zákazník na mobile klikne „Objednať“, spojenie sa zasekne, on klikne
 * znova — a prevádzke pristanú dve objednávky. Preto si pred prvým
 * odoslaním vygenerujeme kľúč, uložíme ho a pri opakovaní pošleme ten
 * istý; server podľa neho vráti pôvodnú objednávku.
 *
 * Kľúč je viazaný na obsah objednávky. Keď zákazník po chybe niečo
 * zmení (opraví adresu, uberie položku), ide o inú objednávku a kľúč
 * sa vymení — inak by server hlásil konflikt.
 */

interface StoredKey {
  key: string;
  fingerprint: string;
}

export interface OrderShape {
  items: CartItem[];
  customer: CustomerDetails;
  orderType: OrderType;
  paymentMethod: PaymentMethod;
  coupon?: string;
}

function randomKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // Staršie prehliadače (a servery pri prerenderi) nemajú randomUUID.
  return `enzo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Odtlačok objednávky — čo, koľko, komu a kam. */
function fingerprint(o: OrderShape): string {
  const items = o.items
    .map((i) => {
      const extras = i.extras
        .map((e) => e.id)
        .sort()
        .join(",");
      return `${i.productId}|${i.quantity}|${i.note ?? ""}|${extras}`;
    })
    .sort()
    .join(";");

  const c = o.customer;
  const who = [c.firstName, c.lastName, c.phone, c.email, c.street, c.houseNumber, c.city, c.postalCode]
    .map((v) => (v ?? "").trim().toLowerCase())
    .join("|");

  return `${o.orderType}|${o.paymentMethod}|${(o.coupon ?? "").toUpperCase()}|${who}|${items}`;
}

/** Kľúč pre túto objednávku — rovnaký pri retry, nový po zmene obsahu. */
export function idempotencyKeyFor(order: OrderShape): string {
  const print = fingerprint(order);
  const stored = readJSON<StoredKey | null>(STORAGE_KEYS.idempotency, null);

  if (stored && stored.fingerprint === print && stored.key) {
    return stored.key;
  }

  const key = randomKey();
  writeJSON(STORAGE_KEYS.idempotency, { key, fingerprint: print } satisfies StoredKey);
  return key;
}

/** Po úspešnej objednávke kľúč zahodíme — ďalšia je už nová. */
export function clearIdempotencyKey(): void {
  remove(STORAGE_KEYS.idempotency);
}
