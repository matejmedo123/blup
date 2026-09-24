"use client";

import { RESTAURANT } from "@/lib/config";
import { useMenu } from "@/context/MenuContext";
import { Reveal } from "@/components/ui/Reveal";
import { ClockIcon, MailIcon, PhoneIcon, PinIcon } from "@/components/ui/Icons";

export function ContactSection() {
  // Adresa, telefón, e-mail aj hodiny sú tie, čo má prevádzka v admine.
  const { shop, hours, zones } = useMenu();
  // Kým sa server neozve, ukážeme obce z konfigurácie, nie prázdno.
  const zoneNames = zones.length ? zones.map((z) => z.name) : RESTAURANT.deliveryZones;

  return (
    <section id="kontakt" aria-labelledby="kontakt-heading" className="bg-cream py-16 lg:py-24">
      <div className="container-enzo">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <p className="eyebrow text-burgundy">Kontakt</p>
            <h2
              id="kontakt-heading"
              className="mt-5 font-display text-[2.2rem] leading-[1.05] text-ink sm:text-[3.2rem]"
            >
              Smashed in
              <br />
              <span className="text-burgundy">{shop.city}</span>
            </h2>
            <p className="mt-6 max-w-md text-[1rem] leading-relaxed text-ink/60">
              Nájdeš nás v centre obce. Prídi si sadnúť alebo si objednaj domov —
              rozvážame do {zoneNames.length} obcí v okolí.
            </p>

          </Reveal>

          <Reveal delay={120}>
            <dl className="flex flex-col gap-6">
              <ContactRow icon={<PinIcon className="h-5 w-5" />} label="Adresa">
                {shop.street}, {shop.postalCode} {shop.city}
              </ContactRow>
              <ContactRow icon={<PhoneIcon className="h-5 w-5" />} label="Telefón">
                <a
                  href={`tel:${shop.phoneHref}`}
                  className="link-underline transition-colors hover:text-burgundy"
                >
                  {shop.phone}
                </a>
              </ContactRow>
              <ContactRow icon={<MailIcon className="h-5 w-5" />} label="E-mail">
                <a
                  href={`mailto:${shop.email}`}
                  className="link-underline break-all transition-colors hover:text-burgundy"
                >
                  {shop.email}
                </a>
              </ContactRow>
              <ContactRow icon={<ClockIcon className="h-5 w-5" />} label="Otváracie hodiny">
                <ul className="flex flex-col gap-1">
                  {hours.map((h) => (
                    <li key={h.days} className="flex flex-wrap gap-x-3">
                      <span className="text-ink/55">{h.days}</span>
                      <span className="font-semibold">{h.time}</span>
                    </li>
                  ))}
                </ul>
              </ContactRow>
            </dl>

            <div className="mt-9">
              <p className="eyebrow text-ink/45">Doručujeme do</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {zoneNames.map((z) => (
                  <li
                    key={z}
                    className="rounded-full border border-burgundy/25 px-3.5 py-1.5 text-[0.78rem] font-semibold text-burgundy"
                  >
                    {z}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

        </div>
      </div>
    </section>
  );
}

function ContactRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-burgundy/10 text-burgundy">
        {icon}
      </span>
      <div>
        <dt className="eyebrow text-ink/45">{label}</dt>
        <dd className="mt-1.5 text-[0.98rem] text-ink">{children}</dd>
      </div>
    </div>
  );
}
