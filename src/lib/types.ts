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
  /** false = prevádzka položku dočasne vypla v admine. Chýbajúce = dostupné. */
  available?: boolean;
  /** Varianty s pravidlami — napr. povinná veľkosť, najviac dve omáčky. */
  modifierGroups?: ModifierGroup[];
}

/**
 * Skupina volieb pri produkte.
 *
 * `required` a `minSelect` hovoria, koľko toho musí zákazník vybrať,
 * `maxSelect` koľko najviac (0 = bez obmedzenia). To isté kontroluje
 * aj server — tu to je preto, aby sa dalo objednať bez hádania.
 */
export interface ModifierGroup {
  id: string;
  name: string;
  hint?: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  options: ExtraOption[];
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

/**
 * Stavy objednávky. Musia sedieť s `OrderStatus` na serveri —
 * ten rozhoduje, čo po čom môže nasledovať.
 */
export type OrderStatus =
  | "received"    // prijatá, čaká na prevádzku
  | "accepted"    // prevádzka prijala a povedala čas prípravy
  | "preparing"   // je na platni
  | "ready"       // hotové
  | "delivering"  // kuriér vyrazil (len rozvoz)
  | "picked_up"   // zákazník si vyzdvihol (len osobný odber)
  | "completed"   // vybavená
  | "rejected"    // prevádzka odmietla
  | "cancelled";

export type PaymentStatus = "unpaid" | "pending" | "paid" | "refunded";

/** Položka objednávky — snapshot v čase objednania. */
export interface OrderItem {
  key: string;
  productId: string;
  name: string;
  basePrice: number;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  extras: ExtraOption[];
  note?: string | null;
  image?: string | null;
}

export interface VatLine {
  rate: number;
  base: number;
  vat: number;
  gross: number;
}

export interface Order {
  orderNumber: string;
  /** Účtovný doklad — prideľuje sa až pri vybavení objednávky */
  docNumber?: string | null;
  status: OrderStatus;
  statusLabel?: string;
  orderType: OrderType;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  createdAt: string;
  /** Kedy bude hotové — nastaví prevádzka v admine */
  readyAt?: string | null;
  prepMinutes?: number | null;
  customer: CustomerDetails;
  items: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  /** Zľava z kupónu v EUR (0 keď žiadny nebol). */
  discount?: number;
  couponCode?: string | null;
  /** Doručovacia zóna, do ktorej adresa spadla. */
  zoneName?: string | null;
  total: number;
  vat?: Record<string, VatLine>;
  /** Orientačný text, kým prevádzka nepotvrdí presný čas */
  estimatedTime?: string;
}
