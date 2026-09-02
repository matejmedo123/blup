import type { CartItem, CustomerDetails, Order, OrderType, PaymentMethod } from "./types";
import type { Category, Product } from "./types";

/**
 * Komunikácia s PHP backendom.
 *
 * Web funguje aj bez neho: menu má v balíku statickú kópiu a keď API
 * neodpovie, stránka sa nerozsype — len sa objednávka nedá odoslať.
 */

/** Adresa API. Prázdna = rovnaká doména ako web (bežný prípad). */
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");

const url = (path: string) => `${API_BASE}/api/${path}`;

export interface ApiError extends Error {
  status: number;
  fields: Record<string, string>;
}

function apiError(message: string, status: number, fields: Record<string, string> = {}): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  err.fields = fields;
  return err;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    throw apiError("Server odpovedal neočakávane. Skús to znova.", res.status);
  }

  const payload = body as { ok?: boolean; data?: T; error?: string; fields?: Record<string, string> };
  if (!res.ok || payload.ok === false) {
    throw apiError(
      payload.error ?? "Niečo sa pokazilo. Skús to znova.",
      res.status,
      payload.fields ?? {},
    );
  }
  return payload.data as T;
}

/* ------------------------------------------------------------------ */
/*  Menu                                                               */
/* ------------------------------------------------------------------ */

export interface MenuResponse {
  categories: Category[];
  products: Product[];
  version: string;
}

export function fetchMenu(signal?: AbortSignal): Promise<MenuResponse> {
  return request<MenuResponse>("menu.php", { method: "GET", signal });
}

/* ------------------------------------------------------------------ */
/*  Nastavenia prevádzky                                               */
/* ------------------------------------------------------------------ */

export interface ShopSettings {
  shop: {
    name: string; street: string; city: string; postalCode: string;
    phone: string; email: string; instagram: string; facebook: string;
  };
  company: { name: string; ico: string; dic: string; seat: string; manager: string };
  order: {
    acceptingOrders: boolean;
    closedMessage: string;
    deliveryFee: number;
    freeDeliveryFrom: number;
    minOrder: number;
    prepTimePickup: string;
    prepTimeDelivery: string;
  };
  payments: { cash: boolean; card: boolean };
  hours: { days: string; time: string }[];
  zones: string[];
}

export function fetchSettings(signal?: AbortSignal): Promise<ShopSettings> {
  return request<ShopSettings>("settings.php", { method: "GET", signal });
}

/* ------------------------------------------------------------------ */
/*  Objednávky                                                         */
/* ------------------------------------------------------------------ */

export interface CreateOrderPayload {
  items: CartItem[];
  customer: CustomerDetails;
  orderType: OrderType;
  paymentMethod: PaymentMethod;
  termsAccepted: boolean;
}

export interface CreateOrderResult {
  order: Order;
  token: string;
  /** Pri platbe kartou adresa platobnej brány, kam treba presmerovať. */
  checkoutUrl?: string | null;
  warning?: string;
}

export function createOrder(payload: CreateOrderPayload): Promise<CreateOrderResult> {
  return request<CreateOrderResult>("orders.php", {
    method: "POST",
    body: JSON.stringify({
      orderType: payload.orderType,
      paymentMethod: payload.paymentMethod,
      termsAccepted: payload.termsAccepted,
      customer: payload.customer,
      // serveru posielame len čo a koľko — ceny si dopočíta sám
      items: payload.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        note: i.note,
        extras: i.extras.map((e) => ({ id: e.id })),
      })),
    }),
  });
}

export function fetchOrder(orderNumber: string, token: string): Promise<{ order: Order }> {
  const q = `c=${encodeURIComponent(orderNumber)}&t=${encodeURIComponent(token)}`;
  return request<{ order: Order }>(`order.php?${q}`, { method: "GET" });
}
