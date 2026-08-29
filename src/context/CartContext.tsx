"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  addItem as addItemPure,
  calcTotals,
  countItems,
  createCartItem,
  removeItem as removeItemPure,
  setQuantity as setQuantityPure,
  subtotal as subtotalPure,
} from "@/lib/cart";
import { lockScroll, unlockScroll } from "@/lib/scrollLock";
import { readJSON, STORAGE_KEYS, writeJSON } from "@/lib/storage";
import type { CartItem, ExtraOption, OrderTotals, OrderType, Product } from "@/lib/types";

interface CartContextValue {
  items: CartItem[];
  /** true až po načítaní z localStorage — bráni hydratačnému nesúladu */
  hydrated: boolean;
  itemCount: number;
  subtotal: number;
  totals: OrderTotals;
  orderType: OrderType;
  setOrderType: (type: OrderType) => void;
  addProduct: (
    product: Product,
    options?: { extras?: ExtraOption[]; quantity?: number; note?: string },
  ) => void;
  updateQuantity: (key: string, quantity: number) => void;
  removeLine: (key: string) => void;
  clear: () => void;
  /** Otvorenie/zatvorenie bočného košíka */
  isCartOpen: boolean;
  openCart: () => void;
  closeCart: () => void;
  /** Inkrementuje sa pri každom pridaní — používa sa na animáciu odznaku */
  bump: number;
  /** Posledná pridaná položka pre potvrdzovací toast */
  lastAdded: { name: string; quantity: number; token: number } | null;
  dismissLastAdded: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

interface PersistedCart {
  items: CartItem[];
  orderType: OrderType;
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [orderType, setOrderTypeState] = useState<OrderType>("delivery");
  const [hydrated, setHydrated] = useState(false);
  const [isCartOpen, setCartOpen] = useState(false);
  const [bump, setBump] = useState(0);
  const [lastAdded, setLastAdded] = useState<CartContextValue["lastAdded"]>(null);
  const skipWrite = useRef(true);

  /* --- načítanie z localStorage (iba na klientovi) --- */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- jednorazová hydratácia košíka z localStorage po pripojení */
    const saved = readJSON<PersistedCart | null>(STORAGE_KEYS.cart, null);
    if (saved && Array.isArray(saved.items)) {
      setItems(saved.items.filter(isValidItem));
      if (saved.orderType === "pickup" || saved.orderType === "delivery") {
        setOrderTypeState(saved.orderType);
      }
    }
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  /* --- zápis do localStorage --- */
  useEffect(() => {
    if (!hydrated) return;
    if (skipWrite.current) {
      skipWrite.current = false;
      return;
    }
    writeJSON(STORAGE_KEYS.cart, { items, orderType } satisfies PersistedCart);
  }, [items, orderType, hydrated]);

  /* --- zamknutie scrollu pri otvorenom košíku --- */
  useEffect(() => {
    if (!isCartOpen) return;
    lockScroll();
    return unlockScroll;
  }, [isCartOpen]);

  const addProduct = useCallback<CartContextValue["addProduct"]>((product, options) => {
    const line = createCartItem(
      product,
      options?.extras ?? [],
      options?.quantity ?? 1,
      options?.note,
    );
    setItems((current) => addItemPure(current, line));
    setBump((b) => b + 1);
    setLastAdded({ name: line.name, quantity: line.quantity, token: Date.now() });
  }, []);

  const dismissLastAdded = useCallback(() => setLastAdded(null), []);

  const updateQuantity = useCallback((key: string, quantity: number) => {
    setItems((current) => setQuantityPure(current, key, quantity));
  }, []);

  const removeLine = useCallback((key: string) => {
    setItems((current) => removeItemPure(current, key));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const setOrderType = useCallback((type: OrderType) => setOrderTypeState(type), []);
  const openCart = useCallback(() => {
    setLastAdded(null);
    setCartOpen(true);
  }, []);
  const closeCart = useCallback(() => setCartOpen(false), []);

  const value = useMemo<CartContextValue>(() => {
    return {
      items,
      hydrated,
      itemCount: countItems(items),
      subtotal: subtotalPure(items),
      totals: calcTotals(items, orderType),
      orderType,
      setOrderType,
      addProduct,
      updateQuantity,
      removeLine,
      clear,
      isCartOpen,
      openCart,
      closeCart,
      bump,
      lastAdded,
      dismissLastAdded,
    };
  }, [
    items,
    hydrated,
    orderType,
    setOrderType,
    addProduct,
    updateQuantity,
    removeLine,
    clear,
    isCartOpen,
    openCart,
    closeCart,
    bump,
    lastAdded,
    dismissLastAdded,
  ]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart musí byť použitý vnútri <CartProvider>.");
  return ctx;
}

function isValidItem(item: unknown): item is CartItem {
  if (!item || typeof item !== "object") return false;
  const i = item as Partial<CartItem>;
  return (
    typeof i.key === "string" &&
    typeof i.productId === "string" &&
    typeof i.name === "string" &&
    typeof i.basePrice === "number" &&
    typeof i.quantity === "number" &&
    Array.isArray(i.extras)
  );
}
