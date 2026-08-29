/** Tenká, bezpečná obálka nad localStorage (SSR-safe, nespadne v privátnom režime). */

export function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* kvóta / privátny režim — ticho ignorujeme */
  }
}

export function remove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

export const STORAGE_KEYS = {
  cart: "enzo.cart.v1",
  orders: "enzo.orders.v1",
  lastOrder: "enzo.lastOrder.v1",
  orderCounter: "enzo.orderCounter.v1",
  checkout: "enzo.checkoutDraft.v1",
} as const;
