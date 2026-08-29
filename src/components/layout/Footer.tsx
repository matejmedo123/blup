import Link from "next/link";
import { RESTAURANT } from "@/lib/config";
import { Logo } from "@/components/ui/Logo";
import { ClockIcon, FacebookIcon, InstagramIcon, MailIcon, PhoneIcon, PinIcon } from "@/components/ui/Icons";

const LINKS = [
  { href: "/#menu", label: "Menu" },
  { href: "/#o-nas", label: "O nás" },
  { href: "/#ako-to-funguje", label: "Ako to funguje" },
  { href: "/#kontakt", label: "Kontakt" },
  { href: "/podmienky", label: "Obchodné podmienky" },
  { href: "/ochrana-osobnych-udajov", label: "Ochrana osobných údajov" },
];

export function Footer() {
  return (
    <footer className="no-print bg-burgundy text-cream">
      <div
        aria-hidden
        className="checkerboard h-3 w-full text-cream"
        style={{ ["--checker-size" as string]: "0.75rem" }}
      />

      <div className="container-enzo grid gap-12 py-14 md:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.1fr] lg:gap-10 lg:py-20">
        {/* Brand */}
        <div>
          <Logo tone="cream" withDescriptor className="text-[3.2rem]" />
          <p className="mt-6 max-w-xs text-sm leading-relaxed text-cream/70">
            Poctivý smash burger, chrumkavé hranolky a dobrá atmosféra.
            Smashujeme čerstvo, servírujeme horúce.
          </p>
          <p className="mt-5 font-display text-2xl text-gold">{RESTAURANT.claim}</p>
        </div>

        {/* Navigácia */}
        <nav aria-label="Pätička — navigácia">
          <h2 className="eyebrow text-cream/50">Navigácia</h2>
          <ul className="mt-5 flex flex-col gap-3">
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="link-underline text-[0.95rem] font-semibold text-cream/85 transition-colors hover:text-cream"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* Kontakt */}
        <div>
          <h2 className="eyebrow text-cream/50">Kontakt</h2>
          <ul className="mt-5 flex flex-col gap-4 text-[0.95rem]">
            <li className="flex gap-3">
              <PinIcon className="mt-0.5 h-4.5 w-4.5 shrink-0 text-gold" />
              <span className="text-cream/85">
                {RESTAURANT.address.street}
                <br />
                {RESTAURANT.address.postalCode} {RESTAURANT.address.city}
              </span>
            </li>
            <li>
              <a
                href={`tel:${RESTAURANT.phoneHref}`}
                className="flex gap-3 text-cream/85 transition-colors hover:text-cream"
              >
                <PhoneIcon className="mt-0.5 h-4.5 w-4.5 shrink-0 text-gold" />
                {RESTAURANT.phone}
              </a>
            </li>
            <li>
              <a
                href={`mailto:${RESTAURANT.email}`}
                className="flex gap-3 break-all text-cream/85 transition-colors hover:text-cream"
              >
                <MailIcon className="mt-0.5 h-4.5 w-4.5 shrink-0 text-gold" />
                {RESTAURANT.email}
              </a>
            </li>
          </ul>

          <div className="mt-6 flex gap-3">
            <SocialLink href={RESTAURANT.instagram} label="ENZO na Instagrame">
              <InstagramIcon className="h-5 w-5" />
            </SocialLink>
            <SocialLink href={RESTAURANT.facebook} label="ENZO na Facebooku">
              <FacebookIcon className="h-5 w-5" />
            </SocialLink>
          </div>
        </div>

        {/* Otváracie hodiny */}
        <div>
          <h2 className="eyebrow text-cream/50">Otváracie hodiny</h2>
          <ul className="mt-5 flex flex-col gap-3 text-[0.95rem]">
            {RESTAURANT.hours.map((h) => (
              <li key={h.days} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2 text-cream/60">
                  <ClockIcon className="h-4 w-4 text-gold" />
                  {h.days}
                </span>
                <span className="pl-6 font-display text-lg text-cream">{h.time}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="border-t border-cream/15">
        <div className="container-enzo flex flex-col gap-3 py-6 text-xs text-cream/55 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {RESTAURANT.legalName} — {RESTAURANT.since},{" "}
            {RESTAURANT.place}
          </p>
          <p className="font-sans font-bold tracking-[0.2em] text-cream/70 uppercase">
            {RESTAURANT.tagline}
          </p>
        </div>
      </div>
    </footer>
  );
}

function SocialLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="flex h-11 w-11 items-center justify-center rounded-full border border-cream/25 text-cream transition-colors hover:border-gold hover:bg-gold hover:text-ink"
    >
      {children}
    </a>
  );
}
