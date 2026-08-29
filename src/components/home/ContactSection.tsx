import Image from "next/image";
import { RESTAURANT } from "@/lib/config";
import { Reveal } from "@/components/ui/Reveal";
import { ClockIcon, MailIcon, PhoneIcon, PinIcon } from "@/components/ui/Icons";

export function ContactSection() {
  return (
    <section id="kontakt" aria-labelledby="kontakt-heading" className="bg-cream py-16 lg:py-24">
      <div className="container-enzo">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
          <Reveal>
            <p className="eyebrow text-burgundy">Kontakt</p>
            <h2
              id="kontakt-heading"
              className="mt-5 font-display text-[2.8rem] leading-[1.02] text-ink sm:text-[4rem]"
            >
              Smashed in
              <br />
              <span className="text-burgundy">{RESTAURANT.place}</span>
            </h2>
            <p className="mt-6 max-w-md text-[1rem] leading-relaxed text-ink/60">
              Nájdeš nás na hlavnej. Prídi si sadnúť alebo si objednaj domov —
              doručujeme do {RESTAURANT.deliveryZones.length} obcí v okolí.
            </p>

            <dl className="mt-9 flex flex-col gap-6">
              <ContactRow icon={<PinIcon className="h-5 w-5" />} label="Adresa">
                {RESTAURANT.address.street}, {RESTAURANT.address.postalCode}{" "}
                {RESTAURANT.address.city}
              </ContactRow>
              <ContactRow icon={<PhoneIcon className="h-5 w-5" />} label="Telefón">
                <a
                  href={`tel:${RESTAURANT.phoneHref}`}
                  className="link-underline transition-colors hover:text-burgundy"
                >
                  {RESTAURANT.phone}
                </a>
              </ContactRow>
              <ContactRow icon={<MailIcon className="h-5 w-5" />} label="E-mail">
                <a
                  href={`mailto:${RESTAURANT.email}`}
                  className="link-underline break-all transition-colors hover:text-burgundy"
                >
                  {RESTAURANT.email}
                </a>
              </ContactRow>
              <ContactRow icon={<ClockIcon className="h-5 w-5" />} label="Otváracie hodiny">
                <ul className="flex flex-col gap-1">
                  {RESTAURANT.hours.map((h) => (
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
                {RESTAURANT.deliveryZones.map((z) => (
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

          <Reveal delay={120} className="flex flex-col gap-4">
            <div className="relative aspect-4/3 w-full overflow-hidden rounded-2xl bg-ink">
              <Image
                src="/images/editorial/interior.webp"
                alt="Interiér prevádzky ENZO — tmavé drevo, teplé svetlo a bordové boxy"
                fill
                loading="lazy"
                sizes="(max-width: 1024px) 100vw, 55vw"
                className="object-cover"
              />
              <div aria-hidden className="absolute inset-0 bg-burgundy/12 mix-blend-multiply" />
              <div className="absolute bottom-5 left-5 rounded-xl bg-burgundy px-5 py-4 text-cream">
                <p className="font-display text-[1.5rem] leading-[1.05]">
                  Smashed in {RESTAURANT.place}
                </p>
                <p className="mt-1 text-[0.7rem] font-bold tracking-[0.18em] text-cream/60 uppercase">
                  {RESTAURANT.since}
                </p>
              </div>
            </div>

            <div className="relative aspect-16/9 w-full overflow-hidden rounded-2xl bg-ink sm:aspect-21/9">
              <Image
                src="/images/editorial/interior-2.webp"
                alt="Priestor ENZO s otvorenou kuchyňou a menu tabuľou"
                fill
                loading="lazy"
                sizes="(max-width: 1024px) 100vw, 55vw"
                className="object-cover"
              />
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
