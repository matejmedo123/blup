/**
 * Doménové typy ENZO objednávkového systému.
 * Zámerne oddelené od UI, aby sa dali neskôr napojiť na backend/API.
 */

export type CategoryId =
  | "burgers"
  | "chicken"
  | "pork"
  | "pizza"
  | "kombo"
  | "sides"
  | "sweets"
  | "drinks";

export interface Category {
  id: CategoryId;
  /** Krátky názov pre taby */
  label: string;
  /** Nadpis sekcie */
  title: string;
  /** Podtitulok / claim sekcie */
  caption: string;
}

export interface ExtraOption {
  id: string;
  name: string;
  price: number;
}

export type LidAccent = "cream" | "red" | "gold" | "burgundy";

export interface Product {
  id: string;
  name: string;
  description: string;
  /** Základná cena v EUR */
  price: number;
  category: CategoryId;
  /** Cesta k optimalizovanému obrázku v /public */
  image?: string;
  imageAlt?: string;
  /** Napr. "NAJPREDÁVANEJŠIE", "NOVINKA" */
  badge?: string;
  tags?: string[];
  /** Voliteľné doplnky pre modal produktu */
  extras?: ExtraOption[];
  /** Grafická náhrada fotky (omáčky) — dizajn viečka podľa brand boardu */
  lid?: { accent: LidAccent; lines: [string, string] };
}

/** Položka v košíku — snapshot produktu, aby objednávka ostala stabilná. */
export interface CartItem {
  /** Unikátny kľúč: productId + zvolené doplnky */
  key: string;
  productId: string;
  name: string;
  basePrice: number;
  image?: string;
  extras: ExtraOption[];
  quantity: number;
  note?: string;
}

export type OrderType = "pickup" | "delivery";
export type PaymentMethod = "card" | "cash";

export interface CustomerDetails {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  /** Iba pri osobnom odbere */
  pickupTime?: string;
  /** Iba pri doručení */
  street?: string;
  houseNumber?: string;
  city?: string;
  postalCode?: string;
  note?: string;
}

export interface OrderTotals {
  subtotal: number;
  deliveryFee: number;
  total: number;
  itemCount: number;
}

export type OrderStatus = "received" | "preparing" | "ready" | "delivering";

export interface Order {
  orderNumber: string;
  createdAt: string;
  orderType: OrderType;
  paymentMethod: PaymentMethod;
  paymentState: "demo-paid" | "pay-on-spot";
  customer: CustomerDetails;
  items: CartItem[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  estimatedTime: string;
  status: OrderStatus;
}
