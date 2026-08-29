import type { CartItem, ExtraOption, OrderTotals, OrderType, Product } from "./types";
import { ORDER_CONFIG } from "./config";
import { round2 } from "./format";

/** Stabilný kľúč položky — rovnaký produkt s rovnakými doplnkami sa zlúči. */
export function makeItemKey(productId: string, extras: ExtraOption[], note?: string): string {
  const ids = extras.map((e) => e.id).sort().join("+");
  const n = note?.trim() ? `#${note.trim().toLowerCase()}` : "";
  return `${productId}${ids ? `|${ids}` : ""}${n}`;
}

export function createCartItem(
  product: Product,
  extras: ExtraOption[] = [],
  quantity = 1,
  note?: string,
): CartItem {
  return {
    key: makeItemKey(product.id, extras, note),
    productId: product.id,
    name: product.name,
    basePrice: product.price,
    image: product.image,
    extras,
    quantity,
    note: note?.trim() || undefined,
  };
}

/** Cena jedného kusu vrátane doplnkov. */
export function itemUnitPrice(item: CartItem): number {
  return round2(item.basePrice + item.extras.reduce((sum, e) => sum + e.price, 0));
}

export function itemLineTotal(item: CartItem): number {
  return round2(itemUnitPrice(item) * item.quantity);
}

export function addItem(items: CartItem[], incoming: CartItem): CartItem[] {
  const index = items.findIndex((i) => i.key === incoming.key);
  if (index === -1) return [...items, incoming];
  const next = [...items];
  next[index] = {
    ...next[index],
    quantity: Math.min(next[index].quantity + incoming.quantity, 99),
  };
  return next;
}

export function setQuantity(items: CartItem[], key: string, quantity: number): CartItem[] {
  if (quantity <= 0) return removeItem(items, key);
  return items.map((i) => (i.key === key ? { ...i, quantity: Math.min(quantity, 99) } : i));
}

export function removeItem(items: CartItem[], key: string): CartItem[] {
  return items.filter((i) => i.key !== key);
}

export function countItems(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.quantity, 0);
}

export function subtotal(items: CartItem[]): number {
  return round2(items.reduce((sum, i) => sum + itemLineTotal(i), 0));
}

export function deliveryFeeFor(sub: number, orderType: OrderType): number {
  if (orderType === "pickup") return 0;
  if (sub >= ORDER_CONFIG.freeDeliveryFrom) return 0;
  return ORDER_CONFIG.deliveryFee;
}

export function calcTotals(items: CartItem[], orderType: OrderType = "delivery"): OrderTotals {
  const sub = subtotal(items);
  const fee = deliveryFeeFor(sub, orderType);
  return {
    subtotal: sub,
    deliveryFee: fee,
    total: round2(sub + fee),
    itemCount: countItems(items),
  };
}

/** Splnená minimálna hodnota objednávky? */
export function meetsMinimum(sub: number): boolean {
  return sub >= ORDER_CONFIG.minOrder;
}

export function missingToMinimum(sub: number): number {
  return round2(Math.max(0, ORDER_CONFIG.minOrder - sub));
}

export function missingToFreeDelivery(sub: number): number {
  return round2(Math.max(0, ORDER_CONFIG.freeDeliveryFrom - sub));
}
