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
  /**
   * Kontaktné údaje prevádzky tak, ako ich má nastavené admin.
   * Kým sa server neozve, platí to, čo je v `config.ts`.
   */
  shop: {
    name: string;
    street: string;
    city: string;
    postalCode: string;
    phone: string;
    phoneHref: string;
    email: string;
    instagram: string;
    facebook: string;
  };
  /** Oznam do vyskakovacieho okna. Texty si píše prevádzka v admine. */
  notice: { enabled: boolean; title: string; text: string; cta: string };
  /** Fakturačné údaje do pätičky a na doklad — tiež z adminu. */
  company: { name: string; ico: string; dic: string; seat: string; manager: string };
  /**
   * Keď je v kuchyni nabité, server sám predĺži časy a povie o koľko.
   * Časy v `settings` sú už predĺžené — toto je len na vysvetlenie.
   */
  load: { busy: boolean; extraMinutes: number; note: string };
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

const FALLBACK_SHOP: MenuContextValue["shop"] = {
  name: RESTAURANT.legalName,
  street: RESTAURANT.address.street,
  city: RESTAURANT.address.city,
  postalCode: RESTAURANT.address.postalCode,
  phone: RESTAURANT.phone,
  phoneHref: RESTAURANT.phoneHref,
  email: RESTAURANT.email,
  instagram: RESTAURANT.instagram,
  facebook: RESTAURANT.facebook,
};

const FALLBACK_COMPANY: MenuContextValue["company"] = {
  name: RESTAURANT.company.name,
  ico: RESTAURANT.company.ico,
  dic: RESTAURANT.company.dic,
  seat: RESTAURANT.company.seat,
  manager: RESTAURANT.company.manager,
};

/** Z telefónneho čísla spraví tvar pre odkaz `tel:`. */
function telHref(phone: string, fallback: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits === "") return fallback;
  if (digits.startsWith("+")) return digits;
  // Slovenské číslo zapísané s úvodnou nulou (0948 …) je +421 948 …
  return digits.startsWith("0") ? "+421" + digits.slice(1) : digits;
}

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
  const [load, setLoad] = useState({ busy: false, extraMinutes: 0, note: "" });
  const [shop, setShop] = useState(FALLBACK_SHOP);
  const [company, setCompany] = useState(FALLBACK_COMPANY);
  const [notice, setNotice] = useState({ enabled: false, title: "", text: "", cta: "" });

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
        if (shop.notice) {
          setNotice({
            enabled: shop.notice.enabled === true,
            title: shop.notice.title ?? "",
            text: shop.notice.text ?? "",
            cta: shop.notice.cta ?? "",
          });
        }
        if (shop.company) {
          const c = shop.company;
          const pick = (v: string | undefined, f: string) => (v != null && v.trim() !== "" ? v.trim() : f);
          setCompany({
            name: pick(c.name, FALLBACK_COMPANY.name),
            ico: pick(c.ico, FALLBACK_COMPANY.ico),
            dic: pick(c.dic, FALLBACK_COMPANY.dic),
            seat: pick(c.seat, FALLBACK_COMPANY.seat),
            manager: pick(c.manager, FALLBACK_COMPANY.manager),
          });
        }
        if (shop.shop) {
          // Prázdne pole v admine neprepíše to, čo je v config.ts —
          // inak by sa z webu stratil telefón, kým ho niekto nevyplní.
          const keep = (value: string | undefined, fallback: string) =>
            value != null && value.trim() !== "" ? value.trim() : fallback;
          const phone = keep(shop.shop.phone, FALLBACK_SHOP.phone);
          setShop({
            name: keep(shop.shop.name, FALLBACK_SHOP.name),
            street: keep(shop.shop.street, FALLBACK_SHOP.street),
            city: keep(shop.shop.city, FALLBACK_SHOP.city),
            postalCode: keep(shop.shop.postalCode, FALLBACK_SHOP.postalCode),
            phone,
            phoneHref: telHref(phone, FALLBACK_SHOP.phoneHref),
            email: keep(shop.shop.email, FALLBACK_SHOP.email),
            instagram: keep(shop.shop.instagram, FALLBACK_SHOP.instagram),
            facebook: keep(shop.shop.facebook, FALLBACK_SHOP.facebook),
          });
        }
        setZones(shop.zones ?? []);
        if (shop.hours && shop.hours.length > 0) {
          setHours(shop.hours);
        }
        setLoad({
          busy: shop.load?.busy ?? false,
          extraMinutes: shop.load?.extraMinutes ?? 0,
          note: shop.load?.note ?? "",
        });
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
      load,
      shop,
      company,
      notice,
    };
  }, [categories, products, live, settings, payments, zones, open, hours, load, shop, company, notice]);

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
