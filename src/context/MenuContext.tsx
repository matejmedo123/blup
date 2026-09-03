"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CATEGORIES as STATIC_CATEGORIES, PRODUCTS as STATIC_PRODUCTS } from "@/lib/products";
import { fetchMenu, fetchSettings, type DeliveryZone, type ShopSettings } from "@/lib/api";
import { ORDER_CONFIG, RESTAURANT } from "@/lib/config";
import type { Category, CategoryId, Product } from "@/lib/types";

/**
 * Menu a nastavenia prevádzky.
 *
 * Stránka sa vykreslí okamžite zo statickej kópie zabalenej vo webe,
 * a hneď potom si doťahá aktuálne dáta zo servera. Keď server neodpovie,
 * zákazník aj tak vidí celé menu — len nemusí byť úplne najčerstvejšie.
 */

interface MenuContextValue {
  categories: Category[];
  products: Product[];
  /** Menu zoskupené podľa kategórií, prázdne kategórie vynechané */
  menu: { category: Category; products: Product[] }[];
  getProduct: (id: string) => Product | undefined;
  /** true, keď už máme dáta zo servera */
  live: boolean;
  settings: ShopSettings["order"] & {
    acceptingOrders: boolean;
    closedMessage: string;
  };
  payments: { cash: boolean; card: boolean };
  /** Obce, kam sa rozváža. Prázdne = rozvoz sa podľa obce neobmedzuje. */
  zones: DeliveryZone[];
  /**
   * Či sa práve dá objednať. Rozhoduje server podľa otváracích hodín —
   * web to len zobrazuje, aby zákazník neplnil košík nadarmo.
   */
  open: { now: boolean; reason: string; opensAt: string | null };
  /** Otváracie hodiny na zobrazenie. */
  hours: { days: string; time: string }[];
}

const FALLBACK_SETTINGS: MenuContextValue["settings"] = {
  acceptingOrders: true,
  closedMessage: "Momentálne neprijímame objednávky. Skús to o chvíľu.",
  deliveryFee: ORDER_CONFIG.deliveryFee,
  freeDeliveryFrom: ORDER_CONFIG.freeDeliveryFrom,
  minOrder: ORDER_CONFIG.minOrder,
  prepTimePickup: ORDER_CONFIG.estimatedTimePickup,
  prepTimeDelivery: ORDER_CONFIG.estimatedTimeDelivery,
};

const MenuContext = createContext<MenuContextValue | null>(null);

export function MenuProvider({ children }: { children: ReactNode }) {
  const [categories, setCategories] = useState<Category[]>(STATIC_CATEGORIES);
  const [products, setProducts] = useState<Product[]>(STATIC_PRODUCTS);
  const [live, setLive] = useState(false);
  const [settings, setSettings] = useState(FALLBACK_SETTINGS);
  const [payments, setPayments] = useState({ cash: true, card: false });
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [hours, setHours] = useState<{ days: string; time: string }[]>(() => RESTAURANT.hours.map((h) => ({ ...h })));
  // Kým sa neozve server, tvárime sa otvorene — objednávku aj tak
  // nakoniec posúdi on, a zbytočná hláška „zatvorené“ by len odohnala ľudí.
  const [open, setOpen] = useState({ now: true, reason: "", opensAt: null as string | null });

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const [menu, shop] = await Promise.all([
          fetchMenu(controller.signal),
          fetchSettings(controller.signal),
        ]);
        if (controller.signal.aborted) return;

        if (menu.categories.length > 0 && menu.products.length > 0) {
          setCategories(menu.categories);
          setProducts(menu.products);
        }
        setSettings({
          acceptingOrders: shop.order.acceptingOrders,
          closedMessage: shop.order.closedMessage,
          deliveryFee: shop.order.deliveryFee,
          freeDeliveryFrom: shop.order.freeDeliveryFrom,
          minOrder: shop.order.minOrder,
          prepTimePickup: shop.order.prepTimePickup,
          prepTimeDelivery: shop.order.prepTimeDelivery,
        });
        setPayments(shop.payments);
        setZones(shop.zones ?? []);
        if (shop.hours && shop.hours.length > 0) {
          setHours(shop.hours);
        }
        setOpen({
          now: shop.open?.now ?? true,
          reason: shop.open?.reason ?? "",
          opensAt: shop.open?.opensAt ?? null,
        });
        setLive(true);
      } catch {
        // backend nedostupný — ostávame na statickej kópii
      }
    })();

    return () => controller.abort();
  }, []);

  const value = useMemo<MenuContextValue>(() => {
    const byId = new Map(products.map((p) => [p.id, p]));
    const menu = categories
      .map((category) => ({
        category,
        products: products.filter((p) => p.category === category.id),
      }))
      .filter((group) => group.products.length > 0);

    return {
      categories,
      products,
      menu,
      getProduct: (id: string) => byId.get(id),
      live,
      settings,
      payments,
      zones,
      open,
      hours,
    };
  }, [categories, products, live, settings, payments, zones, open, hours]);

  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
}

export function useMenu(): MenuContextValue {
  const ctx = useContext(MenuContext);
  if (!ctx) throw new Error("useMenu musí byť použitý vnútri <MenuProvider>.");
  return ctx;
}

/** Pomôcka pre komponenty, ktoré potrebujú len jednu kategóriu. */
export function useCategory(id: CategoryId) {
  const { menu } = useMenu();
  return menu.find((m) => m.category.id === id);
}
