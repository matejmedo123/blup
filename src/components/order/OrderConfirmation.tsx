"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { RESTAURANT } from "@/lib/config";
import { formatDateTime, formatPrice } from "@/lib/format";
import { fetchOrder } from "@/lib/api";
import {
  formatReadyTime,
  getLastOrder,
  getStoredOrder,
  ORDER_STATUS_HINT,
  ORDER_STATUS_LABEL,
  ORDER_TYPE_LABEL,
  PAYMENT_LABEL,
  saveOrder,
} from "@/lib/order";
import type { Order, OrderStatus } from "@/lib/types";
import { CheckerRule } from "@/components/ui/Checkerboard";
import { CheckIcon, ClockIcon, PinIcon, PrintIcon } from "@/components/ui/Icons";
import { LogoBadge } from "@/components/ui/Logo";
import { PrintableReceipt } from "./PrintableReceipt";

type State =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "ready"; order: Order; live: boolean };

/** Poradie krokov, ktoré vidí zákazník. */
const STEPS: { key: OrderStatus; label: (isPickup: boolean) => string }[] = [
  { key: "received", label: () => "Objednávka prijatá" },
  { key: "confirmed", label: () => "Pripravujeme" },
  { key: "ready", label: (p) => (p ? "Pripravené na odber" : "Na ceste k tebe") },
  { key: "completed", label: () => "Vybavené" },
];

/** Nadpis potvrdenia sa mení podľa toho, kde objednávka práve je. */
const HEADLINE: Record<OrderStatus, [string, string]> = {
  received: ["Objednávka", "prijatá!"],
  confirmed: ["Už to", "pripravujeme!"],
  ready: ["Hotovo —", "je pripravená!"],
  completed: ["Objednávka", "vybavená"],
  cancelled: ["Objednávka", "zrušená"],
};

export function OrderConfirmation() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  /** Načíta objednávku zo servera; keď sa nedá, siahne po lokálnej kópii. */
  const load = useCallback(async (first: boolean) => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("c");
    const tokenParam = params.get("t");

    const stored = requested ? getStoredOrder(requested) : getLastOrder();
    const number = requested ?? stored?.order.orderNumber ?? null;
    const token = tokenParam ?? stored?.token ?? null;

    if (first && params.get("platba") === "zrusena") {
      setPaymentNotice(
        "Platbu si zrušil. Objednávku máme uloženú — ozvi sa nám a dohodneme sa na platbe pri prevzatí.",
      );
    }

    if (number === null) {
      setState({ status: "empty" });
      return;
    }

    if (token) {
      try {
        const { order } = await fetchOrder(number, token);
        saveOrder(order, token);
        setState({ status: "ready", order, live: true });
        return;
      } catch {
        // server nedostupný — ukážeme aspoň lokálnu kópiu
      }
    }

    if (stored?.order) {
      setState({ status: "ready", order: stored.order, live: false });
    } else {
      setState({ status: "empty" });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prvé načítanie objednávky zo servera po pripojení
    void load(true);
  }, [load]);

  /* Kým objednávka beží, doťahujeme stav — zákazník uvidí potvrdený čas. */
  useEffect(() => {
    if (state.status !== "ready" || !state.live) return;
    if (state.order.status === "completed" || state.order.status === "cancelled") return;

    pollRef.current = window.setInterval(() => void load(false), 30000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [state, load]);

  if (state.status === "loading") {
    return (
      <div className="container-enzo flex min-h-[60vh] items-center justify-center py-20">
        <p className="eyebrow text-ink/40">Načítavame objednávku…</p>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="container-enzo flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
        <h1 className="font-display text-[2.5rem] leading-[1.05] text-ink sm:text-[3.5rem]">
          Objednávka sa nenašla
        </h1>
        <p className="mt-3 max-w-sm text-ink/55">
          Skús otvoriť odkaz z potvrdzovacieho e-mailu — funguje aj na inom zariadení.
        </p>
        <Link
          href="/#menu"
          className="mt-7 inline-flex h-14 items-center rounded-full bg-burgundy px-8 font-sans text-[0.82rem] font-extrabold tracking-[0.14em] text-cream uppercase transition-colors hover:bg-burgundy-700"
        >
          Vytvoriť novú objednávku
        </Link>
      </div>
    );
  }

  const { order, live } = state;
  const c = order.customer;
  const isPickup = order.orderType === "pickup";
  const readyTime = formatReadyTime(order.readyAt);
  const currentStep = STEPS.findIndex((s) => s.key === order.status);
  const cancelled = order.status === "cancelled";

  return (
    <>
      <PrintableReceipt order={order} />

      <div className="print-hide">
        {/* Hlavička s potvrdením */}
        <div className="relative overflow-hidden bg-burgundy text-cream">
          <div
            aria-hidden
            className="checkerboard pointer-events-none absolute inset-0 text-cream/6"
            style={{ ["--checker-size" as string]: "2.5rem" }}
          />
          <div className="container-enzo relative py-14 lg:py-20">
            <div className="flex flex-col items-start gap-7 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <span
                  className={
                    "inline-flex h-16 w-16 animate-[pop_0.5s_cubic-bezier(0.34,1.56,0.64,1)_both] items-center justify-center rounded-full " +
                    (cancelled ? "bg-cream/20 text-cream" : "bg-gold text-ink")
                  }
                >
                  <CheckIcon className="h-8 w-8" strokeWidth={3} />
                </span>
                <h1 className="mt-6 font-display text-[2.3rem] leading-[1.04] opacity-0 [animation:reveal_0.7s_cubic-bezier(0.16,1,0.3,1)_0.12s_both] sm:text-[3.2rem] lg:text-[3.8rem]">
                  {HEADLINE[order.status].map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ))}
                </h1>
                <p className="mt-5 text-[1.1rem] text-cream/80 opacity-0 [animation:reveal_0.7s_cubic-bezier(0.16,1,0.3,1)_0.2s_both]">
                  Ďakujeme, <strong className="text-cream">{c.firstName}</strong>.{" "}
                  {ORDER_STATUS_HINT[order.status]}
                </p>
              </div>

              <LogoBadge className="hidden w-36 shrink-0 text-[9rem] opacity-0 ring-2 ring-cream/25 [animation:pop_0.5s_cubic-bezier(0.34,1.56,0.64,1)_0.3s_both] lg:inline-flex" />
            </div>
          </div>
        </div>
        <CheckerRule className="text-burgundy" size="0.625rem" />

        <div className="container-enzo py-10 lg:py-16">
          {paymentNotice && (
            <div
              role="status"
              className="mb-6 rounded-2xl border border-gold/60 bg-gold/15 px-5 py-4 text-[0.92rem] text-ink/80"
            >
              {paymentNotice}
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr] lg:gap-10">
            {/* Stav a údaje */}
            <div className="flex flex-col gap-6">
              <div className="rounded-2xl bg-white p-6 ring-1 ring-ink/8">
                <p className="eyebrow text-ink/45">Číslo objednávky</p>
                <p className="mt-2 font-display text-[2rem] leading-none text-burgundy sm:text-[2.5rem]">
                  #{order.orderNumber}
                </p>
                <p className="mt-2 text-[0.85rem] text-ink/50">{formatDateTime(order.createdAt)}</p>

                {/* Potvrdený čas z prevádzky */}
                {readyTime && !cancelled ? (
                  <div className="mt-6 rounded-xl bg-gold px-5 py-4 text-center">
                    <p className="eyebrow text-ink/70">
                      {isPickup ? "Hotové o" : "U teba okolo"}
                    </p>
                    <p className="mt-1 font-display text-[2.6rem] leading-none text-ink tabular-nums">
                      {readyTime}
                    </p>
                    {order.prepMinutes ? (
                      <p className="mt-1 text-[0.8rem] text-ink/60">
                        približne {order.prepMinutes} minút
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <span className="inline-flex items-center gap-2 rounded-full bg-gold px-4 py-2.5 font-sans text-[0.7rem] font-extrabold tracking-[0.12em] text-ink uppercase">
                      <span aria-hidden className="h-2 w-2 rounded-full bg-ink" />
                      {ORDER_STATUS_LABEL[order.status]}
                    </span>
                    {order.estimatedTime && (
                      <span className="inline-flex items-center gap-2 rounded-full bg-cream-200 px-4 py-2.5 font-sans text-[0.7rem] font-extrabold tracking-[0.12em] text-burgundy uppercase">
                        <ClockIcon className="h-4 w-4" />
                        {order.estimatedTime}
                      </span>
                    )}
                  </div>
                )}

                {!cancelled && (
                  <ol className="mt-7 flex flex-col gap-0">
                    {STEPS.map((s, i, arr) => {
                      const done = currentStep >= i;
                      return (
                        <li key={s.key} className="flex gap-4">
                          <div className="flex flex-col items-center">
                            <span
                              className={
                                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 " +
                                (done
                                  ? "border-burgundy bg-burgundy text-cream"
                                  : "border-ink/15 bg-white")
                              }
                            >
                              {done ? (
                                <CheckIcon className="h-3.5 w-3.5" strokeWidth={3} />
                              ) : (
                                <span className="h-1.5 w-1.5 rounded-full bg-ink/20" />
                              )}
                            </span>
                            {i < arr.length - 1 && (
                              <span
                                aria-hidden
                                className="my-1 w-0.5 flex-1 rounded bg-ink/10"
                                style={{ minHeight: "1.5rem" }}
                              />
                            )}
                          </div>
                          <p
                            className={
                              "pb-4 text-[0.95rem] " +
                              (done ? "font-bold text-ink" : "text-ink/45")
                            }
                          >
                            {s.label(isPickup)}
                          </p>
                        </li>
                      );
                    })}
                  </ol>
                )}

                {live && !cancelled && order.status !== "completed" && (
                  <p className="mt-2 text-[0.75rem] text-ink/40">
                    Stav sa obnovuje automaticky. Zmenu ti pošleme aj e-mailom.
                  </p>
                )}
              </div>

              <div className="rounded-2xl bg-white p-6 ring-1 ring-ink/8">
                <h2 className="font-display text-[1.15rem] leading-[1.1] text-ink">
                  {ORDER_TYPE_LABEL[order.orderType]}
                </h2>
                <dl className="mt-4 flex flex-col gap-3 text-[0.92rem]">
                  <div className="flex gap-3">
                    <dt className="sr-only">Adresa</dt>
                    <PinIcon className="mt-0.5 h-4.5 w-4.5 shrink-0 text-burgundy" />
                    <dd className="text-ink/75">
                      {order.orderType === "delivery" ? (
                        <>
                          {c.street} {c.houseNumber}
                          <br />
                          {c.postalCode} {c.city}
                        </>
                      ) : (
                        <>
                          {RESTAURANT.address.street}
                          <br />
                          {RESTAURANT.address.postalCode} {RESTAURANT.address.city}
                        </>
                      )}
                    </dd>
                  </div>
                  {isPickup && c.pickupTime && (
                    <div className="flex gap-3">
                      <dt className="sr-only">Čas odberu</dt>
                      <ClockIcon className="mt-0.5 h-4.5 w-4.5 shrink-0 text-burgundy" />
                      <dd className="text-ink/75">Požadovaný čas: {c.pickupTime}</dd>
                    </div>
                  )}
                </dl>

                <div className="mt-5 border-t border-ink/8 pt-5 text-[0.9rem]">
                  <p className="font-bold text-ink">
                    {c.firstName} {c.lastName}
                  </p>
                  <p className="mt-1 text-ink/60">{c.phone}</p>
                  <p className="text-ink/60">{c.email}</p>
                  {c.note && (
                    <p className="mt-3 rounded-lg bg-cream-200 px-3 py-2 text-[0.82rem] text-ink/70 italic">
                      &bdquo;{c.note}&ldquo;
                    </p>
                  )}
                </div>

                <p className="mt-5 rounded-lg bg-cream-200 px-4 py-3 text-[0.82rem] text-ink/70">
                  <strong>Platba:</strong> {PAYMENT_LABEL[order.paymentMethod]}
                  {order.paymentStatus === "paid" && (
                    <span className="ml-2 rounded-full bg-burgundy px-2.5 py-1 text-[0.68rem] font-bold text-cream uppercase">
                      zaplatené
                    </span>
                  )}
                </p>
              </div>
            </div>

            {/* Rekapitulácia */}
            <div className="lg:sticky lg:top-28">
              <div className="rounded-2xl bg-white p-6 ring-1 ring-ink/8">
                <h2 className="font-display text-[1.2rem] leading-[1.1] text-ink">Objednávka</h2>

                <ul className="mt-5 flex flex-col divide-y divide-ink/8 border-y border-ink/8">
                  {order.items.map((item) => (
                    <li key={item.key} className="flex gap-3 py-3.5">
                      <span className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg bg-burgundy px-2 font-display text-[0.95rem] text-cream tabular-nums">
                        {item.quantity}×
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-display text-[0.92rem] leading-[1.18] text-ink">
                          {item.name}
                        </p>
                        {item.extras.length > 0 && (
                          <p className="mt-0.5 text-[0.75rem] text-ink/50">
                            {item.extras.map((e) => `+ ${e.name}`).join(" · ")}
                          </p>
                        )}
                        {item.note && (
                          <p className="mt-0.5 text-[0.75rem] text-ink/45 italic">
                            &bdquo;{item.note}&ldquo;
                          </p>
                        )}
                      </div>
                      <p className="shrink-0 font-display text-[1.05rem] text-burgundy tabular-nums">
                        {formatPrice(item.lineTotal)}
                      </p>
                    </li>
                  ))}
                </ul>

                <dl className="mt-5 flex flex-col gap-2 text-[0.92rem]">
                  <div className="flex justify-between">
                    <dt className="text-ink/60">Medzisúčet</dt>
                    <dd className="font-semibold tabular-nums">{formatPrice(order.subtotal)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ink/60">
                      {order.orderType === "delivery" ? "Doručenie" : "Osobný odber"}
                    </dt>
                    <dd className="font-semibold tabular-nums">
                      {order.deliveryFee === 0 ? "Zdarma" : formatPrice(order.deliveryFee)}
                    </dd>
                  </div>
                  {Object.entries(order.vat ?? {}).map(([group, v]) => (
                    <div key={group} className="flex justify-between text-[0.8rem] text-ink/50">
                      <dt>
                        DPH {group === "drinks" ? "nápoje" : "jedlo"} {v.rate} % (základ{" "}
                        {formatPrice(v.base)})
                      </dt>
                      <dd className="tabular-nums">{formatPrice(v.vat)}</dd>
                    </div>
                  ))}
                  <div className="mt-2 flex items-baseline justify-between border-t border-ink/10 pt-4">
                    <dt className="font-display text-[1.2rem] text-ink">Celkom</dt>
                    <dd className="font-display text-[1.6rem] text-burgundy tabular-nums">
                      {formatPrice(order.total)}
                    </dd>
                  </div>
                </dl>

                <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                  <Link
                    href="/#menu"
                    className="inline-flex h-14 flex-1 items-center justify-center rounded-full bg-burgundy px-6 text-center font-sans text-[0.76rem] font-extrabold tracking-[0.1em] text-cream uppercase transition-colors hover:bg-burgundy-700"
                  >
                    Vytvoriť novú objednávku
                  </Link>
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="inline-flex h-14 items-center justify-center gap-2.5 rounded-full border-2 border-ink/80 px-6 font-sans text-[0.76rem] font-extrabold tracking-[0.1em] text-ink uppercase transition-colors hover:bg-ink hover:text-cream"
                  >
                    <PrintIcon className="h-4.5 w-4.5" />
                    Vytlačiť potvrdenie
                  </button>
                </div>
              </div>

              <div className="mt-6 overflow-hidden rounded-2xl bg-ink p-6 text-cream">
                <p className="font-display text-[1.25rem] leading-[1.12] text-gold">
                  {RESTAURANT.claim}
                </p>
                <p className="mt-3 text-[0.88rem] text-cream/65">
                  Máš otázku k objednávke? Zavolaj nám na{" "}
                  <a
                    href={`tel:${RESTAURANT.phoneHref}`}
                    className="font-bold text-cream underline"
                  >
                    {RESTAURANT.phone}
                  </a>
                  .
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
