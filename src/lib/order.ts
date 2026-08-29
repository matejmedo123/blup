import { ORDER_CONFIG } from "./config";
import { calcTotals } from "./cart";
import { readJSON, remove, STORAGE_KEYS, writeJSON } from "./storage";
import type {
  CartItem,
  CustomerDetails,
  Order,
  OrderType,
  PaymentMethod,
} from "./types";

/** Generuje ďalšie číslo objednávky v tvare ENZO-1048. */
export function nextOrderNumber(): string {
  const current = readJSON<number>(STORAGE_KEYS.orderCounter, ORDER_CONFIG.firstOrderNumber);
  const next = current + 1;
  writeJSON(STORAGE_KEYS.orderCounter, next);
  return `ENZO-${next}`;
}

export interface CreateOrderInput {
  items: CartItem[];
  customer: CustomerDetails;
  orderType: OrderType;
  paymentMethod: PaymentMethod;
}

export function createOrder({
  items,
  customer,
  orderType,
  paymentMethod,
}: CreateOrderInput): Order {
  const totals = calcTotals(items, orderType);
  return {
    orderNumber: nextOrderNumber(),
    createdAt: new Date().toISOString(),
    orderType,
    paymentMethod,
    // Demo prototyp: reálna platobná brána nie je napojená.
    paymentState: paymentMethod === "card" ? "demo-paid" : "pay-on-spot",
    customer,
    items,
    subtotal: totals.subtotal,
    deliveryFee: totals.deliveryFee,
    total: totals.total,
    estimatedTime:
      orderType === "pickup"
        ? ORDER_CONFIG.estimatedTimePickup
        : ORDER_CONFIG.estimatedTimeDelivery,
    status: "received",
  };
}

export function saveOrder(order: Order): void {
  const orders = readJSON<Order[]>(STORAGE_KEYS.orders, []);
  writeJSON(STORAGE_KEYS.orders, [order, ...orders].slice(0, 25));
  writeJSON(STORAGE_KEYS.lastOrder, order);
}

export function getLastOrder(): Order | null {
  return readJSON<Order | null>(STORAGE_KEYS.lastOrder, null);
}

export function getOrders(): Order[] {
  return readJSON<Order[]>(STORAGE_KEYS.orders, []);
}

export function getOrderByNumber(orderNumber: string): Order | null {
  return getOrders().find((o) => o.orderNumber === orderNumber) ?? null;
}

export function clearLastOrder(): void {
  remove(STORAGE_KEYS.lastOrder);
}

export const ORDER_STATUS_LABEL: Record<Order["status"], string> = {
  received: "OBJEDNÁVKA PRIJATÁ",
  preparing: "PRIPRAVUJEME",
  ready: "PRIPRAVENÉ NA ODBER",
  delivering: "NA CESTE K VÁM",
};

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  card: "Platobná karta (demo)",
  cash: "Hotovosť pri prevzatí",
};

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  pickup: "Osobný odber",
  delivery: "Doručenie",
};
