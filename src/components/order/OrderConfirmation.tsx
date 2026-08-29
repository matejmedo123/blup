"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RESTAURANT } from "@/lib/config";
import { itemLineTotal } from "@/lib/cart";
import { formatDateTime, formatPrice } from "@/lib/format";
import {
  getLastOrder,
  getOrderByNumber,
  ORDER_STATUS_LABEL,
  ORDER_TYPE_LABEL,
  PAYMENT_LABEL,
} from "@/lib/order";
import type { Order } from "@/lib/types";
import { CheckerRule } from "@/components/ui/Checkerboard";
import { CheckIcon, ClockIcon, PinIcon, PrintIcon } from "@/components/ui/Icons";
import { LogoBadge } from "@/components/ui/Logo";
import { PrintableReceipt } from "./PrintableReceipt";

type State = { status: "loading" } | { status: "empty" } | { status: "ready"; order: Order };

export function OrderConfirmation({ orderNumber }: { orderNumber?: string }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const order = orderNumber ? getOrderByNumber(orderNumber) : getLastOrder();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- načítanie objednávky z localStorage po hydratácii
    setState(order ? { status: "ready", order } : { status: "empty" });
  }, [orderNumber]);

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
          Objednávku sa nepodarilo načítať. Mohla byť vymazaná z tohto zariadenia.
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

  const { order } = state;
  const c = order.customer;

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
                <span className="inline-flex h-16 w-16 animate-[pop_0.5s_cubic-bezier(0.34,1.56,0.64,1)_both] items-center justify-center rounded-full bg-gold text-ink">
                  <CheckIcon className="h-8 w-8" strokeWidth={3} />
                </span>
                <h1 className="mt-6 font-display text-[2.8rem] leading-[1.02] opacity-0 [animation:reveal_0.7s_cubic-bezier(0.16,1,0.3,1)_0.12s_both] sm:text-[4.2rem] lg:text-[5rem]">
                  Objednávka
                  <br />
                  prijatá!
                </h1>
                <p className="mt-5 text-[1.1rem] text-cream/80 opacity-0 [animation:reveal_0.7s_cubic-bezier(0.16,1,0.3,1)_0.2s_both]">
                  Ďakujeme, <strong className="text-cream">{c.firstName}</strong>. Púšťame ju na
                  platňu.
                </p>
              </div>

              <LogoBadge className="hidden w-36 shrink-0 text-[9rem] opacity-0 [animation:pop_0.5s_cubic-bezier(0.34,1.56,0.64,1)_0.3s_both] lg:inline-flex" />
            </div>
          </div>
        </div>
        <CheckerRule className="text-burgundy" size="0.625rem" />

        <div className="container-enzo py-10 lg:py-16">
          <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr] lg:gap-10">
            {/* Stav a údaje */}
            <div className="flex flex-col gap-6">
              <div className="rounded-2xl bg-white p-6 ring-1 ring-ink/8">
                <p className="eyebrow text-ink/45">Číslo objednávky</p>
                <p className="mt-2 font-display text-[2.6rem] leading-none text-burgundy sm:text-[3.2rem]">
                  #{order.orderNumber}
                </p>
                <p className="mt-2 text-[0.85rem] text-ink/50">
                  {formatDateTime(order.createdAt)}
                </p>

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-2 rounded-full bg-gold px-4 py-2.5 font-sans text-[0.7rem] font-extrabold tracking-[0.12em] text-ink uppercase">
                    <span aria-hidden className="h-2 w-2 rounded-full bg-ink" />
                    {ORDER_STATUS_LABEL[order.status]}
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-full bg-cream-200 px-4 py-2.5 font-sans text-[0.7rem] font-extrabold tracking-[0.12em] text-burgundy uppercase">
                    <ClockIcon className="h-4 w-4" />
                    {order.estimatedTime}
                  </span>
                </div>

                <ol className="mt-7 flex flex-col gap-0">
                  {[
                    { label: "Objednávka prijatá", done: true },
                    { label: "Pripravujeme", done: false },
                    {
                      label:
                        order.orderType === "pickup"
                          ? "Pripravené na odber"
                          : "Na ceste k tebe",
                      done: false,
                    },
                  ].map((s, i, arr) => (
                    <li key={s.label} className="flex gap-4">
                      <div className="flex flex-col items-center">
                        <span
                          className={
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 " +
                            (s.done
                              ? "border-burgundy bg-burgundy text-cream"
                              : "border-ink/15 bg-white")
                          }
                        >
                          {s.done ? (
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
                          (s.done ? "font-bold text-ink" : "text-ink/45")
                        }
                      >
                        {s.label}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="rounded-2xl bg-white p-6 ring-1 ring-ink/8">
                <h2 className="font-display text-[1.5rem] leading-none text-ink">
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
                  {order.orderType === "pickup" && c.pickupTime && (
                    <div className="flex gap-3">
                      <dt className="sr-only">Čas odberu</dt>
                      <ClockIcon className="mt-0.5 h-4.5 w-4.5 shrink-0 text-burgundy" />
                      <dd className="text-ink/75">Čas odberu: {c.pickupTime}</dd>
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
                  {order.paymentState === "demo-paid" && (
                    <span className="block text-[0.75rem] text-ink/45">
                      Demo prototyp — reálna platba sa nespracovala.
                    </span>
                  )}
                </p>
              </div>
            </div>

            {/* Rekapitulácia */}
            <div className="lg:sticky lg:top-28">
              <div className="rounded-2xl bg-white p-6 ring-1 ring-ink/8">
                <h2 className="font-display text-[1.6rem] leading-none text-ink">Objednávka</h2>

                <ul className="mt-5 flex flex-col divide-y divide-ink/8 border-y border-ink/8">
                  {order.items.map((item) => (
                    <li key={item.key} className="flex gap-3 py-3.5">
                      <span className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg bg-burgundy px-2 font-display text-[0.95rem] text-cream tabular-nums">
                        {item.quantity}×
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-display text-[1.05rem] leading-tight text-ink">
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
                        {formatPrice(itemLineTotal(item))}
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
                  <div className="mt-2 flex items-baseline justify-between border-t border-ink/10 pt-4">
                    <dt className="font-display text-[1.6rem] text-ink">Celkom</dt>
                    <dd className="font-display text-[2rem] text-burgundy tabular-nums">
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
                <p className="font-display text-[1.7rem] leading-none text-gold">
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
