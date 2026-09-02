import { ORDER_CONFIG } from "./config";
import { calcTotals, itemLineTotal, itemUnitPrice } from "./cart";
import { readJSON, remove, STORAGE_KEYS, writeJSON } from "./storage";
import type {
  CartItem,
  CustomerDetails,
  Order,
  OrderItem,
  OrderStatus,
  OrderType,
  PaymentMethod,
} from "./types";

/**
 * Objednávka na strane klienta.
 *
 * Zdrojom pravdy je server (PHP backend). Tieto funkcie slúžia na
 * ukladanie kópie do prehliadača, aby zákazník videl potvrdenie aj
 * bez pripojenia a aby fungoval odkaz „posledná objednávka“.
 */

/** Prevedie položky košíka na položky objednávky (fallback bez servera). */
function cartToOrderItems(items: CartItem[]): OrderItem[] {
  return items.map((i) => ({
    key: i.key,
    productId: i.productId,
    name: i.name,
    basePrice: i.basePrice,
    unitPrice: itemUnitPrice(i),
    quantity: i.quantity,
    lineTotal: itemLineTotal(i),
    extras: i.extras,
    note: i.note ?? null,
    image: i.image ?? null,
  }));
}

export interface CreateOrderInput {
  items: CartItem[];
  customer: CustomerDetails;
  orderType: OrderType;
  paymentMethod: PaymentMethod;
}

/**
 * Núdzová objednávka pre prípad, že backend nie je nasadený.
 * Číslo je iba orientačné — skutočné prideľuje server.
 */
export function createLocalOrder({
  items,
  customer,
  orderType,
  paymentMethod,
}: CreateOrderInput): Order {
  const totals = calcTotals(items, orderType);
  const current = readJSON<number>(STORAGE_KEYS.orderCounter, ORDER_CONFIG.firstOrderNumber);
  const next = current + 1;
  writeJSON(STORAGE_KEYS.orderCounter, next);

  return {
    orderNumber: `ENZO-${next}`,
    status: "received",
    statusLabel: "Prijatá",
    orderType,
    paymentMethod,
    paymentStatus: "unpaid",
    createdAt: new Date().toISOString(),
    customer,
    items: cartToOrderItems(items),
    subtotal: totals.subtotal,
    deliveryFee: totals.deliveryFee,
    total: totals.total,
    estimatedTime:
      orderType === "pickup"
        ? ORDER_CONFIG.estimatedTimePickup
        : ORDER_CONFIG.estimatedTimeDelivery,
  };
}

/** Uloží objednávku aj s prístupovým kódom, aby sa dala načítať zo servera. */
export function saveOrder(order: Order, token?: string): void {
  const stored = { order, token: token ?? null };
  const history = readJSON<typeof stored[]>(STORAGE_KEYS.orders, []);
  writeJSON(STORAGE_KEYS.orders, [stored, ...history].slice(0, 25));
  writeJSON(STORAGE_KEYS.lastOrder, stored);
}

export function getLastOrder(): { order: Order; token: string | null } | null {
  return readJSON<{ order: Order; token: string | null } | null>(STORAGE_KEYS.lastOrder, null);
}

export function getOrders(): { order: Order; token: string | null }[] {
  return readJSON<{ order: Order; token: string | null }[]>(STORAGE_KEYS.orders, []);
}

export function getStoredOrder(orderNumber: string): { order: Order; token: string | null } | null {
  return getOrders().find((o) => o.order?.orderNumber === orderNumber) ?? null;
}

/** Prístupový kód k objednávke — potrebný na načítanie zo servera. */
export function getStoredToken(orderNumber: string): string | null {
  return getStoredOrder(orderNumber)?.token ?? null;
}

export function clearLastOrder(): void {
  remove(STORAGE_KEYS.lastOrder);
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  received: "OBJEDNÁVKA PRIJATÁ",
  confirmed: "PRIPRAVUJEME",
  ready: "PRIPRAVENÉ",
  completed: "VYBAVENÉ",
  cancelled: "ZRUŠENÉ",
};

/** Krátky popis pod stavom — čo sa práve deje. */
export const ORDER_STATUS_HINT: Record<OrderStatus, string> = {
  received: "Čakáme, kým prevádzka potvrdí čas prípravy.",
  confirmed: "Objednávka je na platni.",
  ready: "Hotovo — vyzdvihni si ju alebo už je na ceste.",
  completed: "Objednávka je vybavená. Dobrú chuť!",
  cancelled: "Objednávka bola zrušená.",
};

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  card: "Platobná karta",
  cash: "Hotovosť pri prevzatí",
};

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  pickup: "Osobný odber",
  delivery: "Doručenie",
};

/** "18:35" z ISO času, alebo null. */
export function formatReadyTime(readyAt: string | null | undefined): string | null {
  if (!readyAt) return null;
  const d = new Date(readyAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("sk-SK", { hour: "2-digit", minute: "2-digit" }).format(d);
}
