"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCart } from "@/context/CartContext";
import { useMenu } from "@/context/MenuContext";
import { meetsMinimum, missingToMinimum } from "@/lib/cart";
import { formatPrice } from "@/lib/format";
import { createOrder as sendOrder, type ApiError } from "@/lib/api";
import { createLocalOrder, saveOrder } from "@/lib/order";
import { readJSON, STORAGE_KEYS, writeJSON } from "@/lib/storage";
import type { CustomerDetails, OrderType, PaymentMethod } from "@/lib/types";
import { hasErrors, validateCheckout, type FieldErrors } from "@/lib/validation";
import { cn } from "@/lib/utils";
import { TextField } from "@/components/ui/Field";
import { ArrowIcon, BagIcon, CheckIcon } from "@/components/ui/Icons";
import { CheckerRule } from "@/components/ui/Checkerboard";
import { DeliveryForm } from "./DeliveryForm";
import { OrderSummary } from "./OrderSummary";
import { PaymentSelector } from "./PaymentSelector";
import { PickupForm } from "./PickupForm";

const EMPTY_CUSTOMER: CustomerDetails = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  pickupTime: "",
  street: "",
  houseNumber: "",
  city: "Koniarovce",
  postalCode: "",
  note: "",
};

export function Checkout() {
  const router = useRouter();
  const { items, totals, orderType, setOrderType, hydrated, clear, openCart, subtotal, rules } =
    useCart();
  const { settings, payments } = useMenu();

  const [customer, setCustomer] = useState<CustomerDetails>(EMPTY_CUSTOMER);
  const [payment, setPayment] = useState<PaymentMethod>("card");
  const [terms, setTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverFields, setServerFields] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);

  /* Predvyplnenie z posledného konceptu (údaje z predchádzajúcej objednávky) */
  useEffect(() => {
    const draft = readJSON<Partial<CustomerDetails> | null>(STORAGE_KEYS.checkout, null);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- jednorazová synchronizácia s localStorage po hydratácii
    if (draft) setCustomer((c) => ({ ...c, ...draft }));
  }, []);

  /* Chyby sú odvodený stav — počítame ich pri renderi, nie v efekte. */
  const errors: FieldErrors = useMemo(
    () => ({
      ...(attempted ? validateCheckout({ customer, orderType, termsAccepted: terms }) : {}),
      ...serverFields,
    }),
    [attempted, customer, orderType, terms, serverFields],
  );

  /* Keď prevádzka vypne platbu kartou, prepneme voľbu na hotovosť. */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reakcia na nastavenia dotiahnuté zo servera
    if (payment === "card" && !payments.card) setPayment("cash");
    else if (payment === "cash" && !payments.cash && payments.card) setPayment("card");
  }, [payment, payments.card, payments.cash]);

  const belowMinimum = !meetsMinimum(subtotal, rules);
  const isEmpty = hydrated && items.length === 0;
  const closed = !settings.acceptingOrders;

  const update = <K extends keyof CustomerDetails>(field: K, value: CustomerDetails[K]) =>
    setCustomer((c) => ({ ...c, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAttempted(true);

    const nextErrors = validateCheckout({ customer, orderType, termsAccepted: terms });

    if (hasErrors(nextErrors)) {
      const firstKey = Object.keys(nextErrors)[0];
      const el = formRef.current?.querySelector<HTMLElement>(
        firstKey === "terms" ? "#terms" : `#${firstKey}`,
      );
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus({ preventScroll: true });
      return;
    }

    if (belowMinimum || items.length === 0 || closed) return;

    setSubmitting(true);
    setServerError(null);
    setServerFields({});

    // údaje si zapamätáme, nech ich zákazník nabudúce nevypisuje znova
    const rememberCustomer = () =>
      writeJSON(STORAGE_KEYS.checkout, {
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        email: customer.email,
        street: customer.street,
        houseNumber: customer.houseNumber,
        city: customer.city,
        postalCode: customer.postalCode,
      });

    try {
      const result = await sendOrder({
        items,
        customer,
        orderType,
        paymentMethod: payment,
        termsAccepted: terms,
      });

      saveOrder(result.order, result.token);
      rememberCustomer();
      clear();

      // platba kartou → presmerovanie na platobnú bránu
      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
        return;
      }
      router.push(
        `/objednavka/?c=${encodeURIComponent(result.order.orderNumber)}&t=${encodeURIComponent(result.token)}`,
      );
      return;
    } catch (err) {
      const api = err as ApiError;

      // server odmietol konkrétne polia — zvýrazníme ich
      if (api.fields && Object.keys(api.fields).length > 0) {
        setServerFields(api.fields as FieldErrors);
        setServerError(api.message);
        setSubmitting(false);
        formRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }

      // server odmietol objednávku (zatvorené, pod minimom, vypredané…)
      if (api.status >= 400 && api.status < 500) {
        setServerError(api.message);
        setSubmitting(false);
        return;
      }

      // backend nedostupný — objednávku aspoň uložíme lokálne a povieme to
      const local = createLocalOrder({ items, customer, orderType, paymentMethod: payment });
      saveOrder(local);
      rememberCustomer();
      clear();
      router.push(`/objednavka/?c=${encodeURIComponent(local.orderNumber)}&offline=1`);
    }
  };

  /* ---------------- Prázdny košík ---------------- */
  if (isEmpty) {
    return (
      <div className="container-enzo flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-cream-200 text-ink/25">
          <BagIcon className="h-9 w-9" />
        </span>
        <h1 className="mt-6 font-display text-[2.5rem] leading-[1.05] text-ink sm:text-[3.5rem]">
          Košík je prázdny
        </h1>
        <p className="mt-3 max-w-sm text-ink/55">
          Bez objednávky nemáme čo smashovať. Pozri si menu a vyber si svoj burger.
        </p>
        <Link
          href="/#menu"
          className="mt-7 inline-flex h-14 items-center rounded-full bg-burgundy px-8 font-sans text-[0.82rem] font-extrabold tracking-[0.14em] text-cream uppercase transition-colors hover:bg-burgundy-700"
        >
          Pozrieť menu
        </Link>
      </div>
    );
  }

  if (!hydrated) {
    return (
      <div className="container-enzo flex min-h-[60vh] items-center justify-center py-20">
        <p className="eyebrow text-ink/40">Načítavame košík…</p>
      </div>
    );
  }

  return (
    <div className="bg-cream pb-20">
      {/* Hlavička */}
      <div className="bg-burgundy text-cream">
        <div className="container-enzo py-10 lg:py-14">
          <nav aria-label="Omrvinková navigácia">
            <Link
              href="/#menu"
              className="link-underline text-[0.72rem] font-bold tracking-[0.16em] text-cream/60 uppercase"
            >
              ← Späť do menu
            </Link>
          </nav>
          <h1 className="mt-4 font-display text-[2.4rem] leading-[1.02] sm:text-[3.2rem] lg:text-[3.6rem]">
            Pokladňa
          </h1>
          <p className="mt-3 max-w-md text-cream/70">
            Ešte pár údajov a púšťame tvoju objednávku na platňu.
          </p>
        </div>
      </div>
      <CheckerRule className="text-burgundy" size="0.625rem" />

      <div className="container-enzo pt-10 lg:pt-14">
        <div className="grid gap-8 lg:grid-cols-[1.25fr_1fr] lg:items-start lg:gap-12">
          {/* Formulár */}
          <form ref={formRef} onSubmit={handleSubmit} noValidate className="flex flex-col gap-8">
            {/* 1 — spôsob */}
            <Step number="01" title="Spôsob prevzatia">
              <div
                role="radiogroup"
                aria-label="Spôsob prevzatia objednávky"
                className="grid gap-3 sm:grid-cols-2"
              >
                {(
                  [
                    {
                      id: "pickup" as OrderType,
                      title: "Osobný odber",
                      text: `Pripravené za ${settings.prepTimePickup}`,
                      badge: "Zdarma",
                    },
                    {
                      id: "delivery" as OrderType,
                      title: "Doručenie",
                      text: `Doručenie za ${settings.prepTimeDelivery}`,
                      badge: rules.deliveryFee === 0 ? "Zdarma" : formatPrice(rules.deliveryFee),
                    },
                  ] as const
                ).map((o) => {
                  const active = orderType === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setOrderType(o.id)}
                      className={cn(
                        "flex flex-col items-start rounded-xl border-2 bg-white p-5 text-left transition-colors",
                        active ? "border-burgundy bg-burgundy/4" : "border-ink/10 hover:border-ink/25",
                      )}
                    >
                      <span className="flex w-full items-start justify-between gap-3">
                        <span className="font-display text-[1.05rem] leading-[1.1] text-ink">
                          {o.title}
                        </span>
                        <span
                          aria-hidden
                          className={cn(
                            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                            active ? "border-burgundy bg-burgundy text-cream" : "border-ink/25",
                          )}
                        >
                          {active && <CheckIcon className="h-3.5 w-3.5" strokeWidth={3} />}
                        </span>
                      </span>
                      <span className="mt-2 text-[0.85rem] text-ink/55">{o.text}</span>
                      <span className="mt-3 rounded-full bg-cream-200 px-3 py-1 text-[0.68rem] font-bold tracking-[0.1em] text-burgundy uppercase">
                        {o.badge}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Step>

            {/* 2 — kontakt */}
            <Step number="02" title="Kontaktné údaje">
              <div className="flex flex-col gap-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <TextField
                    id="firstName"
                    label="Meno"
                    required
                    autoComplete="given-name"
                    placeholder="Peter"
                    value={customer.firstName}
                    onChange={(e) => update("firstName", e.target.value)}
                    error={errors.firstName}
                  />
                  <TextField
                    id="lastName"
                    label="Priezvisko"
                    required
                    autoComplete="family-name"
                    placeholder="Novák"
                    value={customer.lastName}
                    onChange={(e) => update("lastName", e.target.value)}
                    error={errors.lastName}
                  />
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <TextField
                    id="phone"
                    label="Telefón"
                    required
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="0948 238 346"
                    value={customer.phone}
                    onChange={(e) => update("phone", e.target.value)}
                    error={errors.phone}
                    hint="Zavoláme, keď bude objednávka pripravená."
                  />
                  <TextField
                    id="email"
                    label="E-mail"
                    required
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="peter@example.sk"
                    value={customer.email}
                    onChange={(e) => update("email", e.target.value)}
                    error={errors.email}
                  />
                </div>
              </div>
            </Step>

            {/* 3 — detaily */}
            <Step
              number="03"
              title={orderType === "pickup" ? "Detaily odberu" : "Adresa doručenia"}
            >
              {orderType === "pickup" ? (
                <PickupForm customer={customer} errors={errors} onChange={update} />
              ) : (
                <DeliveryForm customer={customer} errors={errors} onChange={update} />
              )}
            </Step>

            {/* 4 — platba */}
            <Step number="04" title="Platba">
              <PaymentSelector value={payment} onChange={setPayment} allowed={payments} />
            </Step>

            {/* Súhlas + odoslanie */}
            <div className="rounded-2xl bg-white p-5 ring-1 ring-ink/8 sm:p-6">
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border-2 p-4 transition-colors",
                  errors.terms ? "border-burgundy bg-burgundy/4" : "border-ink/10",
                )}
              >
                <input
                  id="terms"
                  type="checkbox"
                  checked={terms}
                  onChange={(e) => setTerms(e.target.checked)}
                  aria-invalid={errors.terms ? true : undefined}
                  aria-describedby={errors.terms ? "terms-error" : undefined}
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors",
                    terms ? "border-burgundy bg-burgundy text-cream" : "border-ink/25 bg-white",
                  )}
                >
                  {terms && <CheckIcon className="h-3.5 w-3.5" strokeWidth={3} />}
                </span>
                <span className="text-[0.88rem] leading-relaxed text-ink/75">
                  Súhlasím s{" "}
                  <Link href="/podmienky" className="font-bold text-burgundy underline">
                    obchodnými podmienkami
                  </Link>{" "}
                  a so{" "}
                  <Link
                    href="/ochrana-osobnych-udajov"
                    className="font-bold text-burgundy underline"
                  >
                    spracovaním osobných údajov
                  </Link>
                  .
                </span>
              </label>
              {errors.terms && (
                <p id="terms-error" role="alert" className="mt-2 text-xs font-semibold text-burgundy">
                  ▲ {errors.terms}
                </p>
              )}

              {closed && (
                <p role="status" className="mt-4 rounded-xl bg-burgundy/10 px-4 py-3 text-[0.85rem] font-semibold text-burgundy">
                  {settings.closedMessage}
                </p>
              )}

              {belowMinimum && (
                <p role="status" className="mt-4 rounded-xl bg-burgundy/8 px-4 py-3 text-[0.85rem] text-burgundy">
                  Minimálna objednávka je{" "}
                  <strong className="tabular-nums">{formatPrice(rules.minOrder)}</strong>.
                  Chýba ešte{" "}
                  <strong className="tabular-nums">{formatPrice(missingToMinimum(subtotal, rules))}</strong>.{" "}
                  <button
                    type="button"
                    onClick={openCart}
                    className="font-bold underline"
                  >
                    Upraviť košík
                  </button>
                </p>
              )}

              {serverError && (
                <p role="alert" className="mt-4 rounded-xl bg-burgundy/10 px-4 py-3 text-[0.85rem] font-semibold text-burgundy">
                  {serverError}
                </p>
              )}

              {attempted && hasErrors(errors) && (
                <p role="alert" className="mt-4 rounded-xl bg-burgundy/8 px-4 py-3 text-[0.85rem] font-semibold text-burgundy">
                  Skontroluj prosím zvýraznené polia — niečo ešte chýba.
                </p>
              )}

              <button
                type="submit"
                disabled={submitting || belowMinimum || closed}
                className="mt-5 flex h-15 w-full items-center justify-center gap-3 rounded-full bg-burgundy font-sans text-[0.85rem] font-extrabold tracking-[0.12em] text-cream uppercase transition-colors hover:bg-burgundy-700 disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/45 sm:h-16 sm:text-[0.92rem]"
              >
                {submitting ? (
                  <>
                    <span
                      aria-hidden
                      className="h-4 w-4 animate-spin rounded-full border-2 border-cream/30 border-t-cream"
                    />
                    Spracúvame…
                  </>
                ) : (
                  <>
                    Objednať a zaplatiť
                    <span className="tabular-nums">{formatPrice(totals.total)}</span>
                    <ArrowIcon className="h-4.5 w-4.5" />
                  </>
                )}
              </button>

              <p className="mt-3 text-center text-[0.72rem] text-ink/45">
                Odoslaním potvrdzuješ objednávku. Ide o demo prototyp — reálna platba
                sa nespracuje.
              </p>
            </div>
          </form>

          {/* Súhrn */}
          <aside className="lg:sticky lg:top-28" aria-label="Súhrn objednávky">
            <OrderSummary
              items={items}
              totals={totals}
              orderType={orderType}
              onEdit={openCart}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white p-5 ring-1 ring-ink/8 sm:p-6">
      <h2 className="flex items-baseline gap-3">
        <span className="font-display text-[1.1rem] text-burgundy/35 tabular-nums">{number}</span>
        <span className="font-display text-[1.2rem] leading-[1.08] text-ink sm:text-[1.4rem]">
          {title}
        </span>
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}
