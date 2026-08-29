import type { Metadata, Viewport } from "next";
import { Anton, Archivo } from "next/font/google";
import { CartProvider } from "@/context/CartContext";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { MobileOrderBar } from "@/components/cart/MobileOrderBar";
import { CartToast } from "@/components/cart/CartToast";
import { RESTAURANT } from "@/lib/config";
import "./globals.css";

const anton = Anton({
  weight: "400",
  subsets: ["latin", "latin-ext"],
  variable: "--font-anton",
  display: "swap",
});

const archivo = Archivo({
  subsets: ["latin", "latin-ext"],
  variable: "--font-archivo",
  display: "swap",
});

const SITE_URL = "https://enzoburgers.sk";
const DESCRIPTION =
  "ENZO Smash Burgers & Fries — poctivý smash burger, chrumkavé hranolky a dobrá atmosféra. Smashed fresh. Served hot. Objednaj online na odber alebo domov.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "ENZO — Smash Burgers & Fries",
    template: "%s | ENZO Smash Burgers & Fries",
  },
  description: DESCRIPTION,
  applicationName: "ENZO",
  keywords: [
    "smash burger",
    "burger Preseľany",
    "hranolky",
    "rozvoz jedla",
    "ENZO burgers",
    "objednávka online",
  ],
  authors: [{ name: RESTAURANT.legalName }],
  openGraph: {
    type: "website",
    locale: "sk_SK",
    url: SITE_URL,
    siteName: RESTAURANT.legalName,
    title: "ENZO — Smash Burgers & Fries",
    description: DESCRIPTION,
    images: [
      {
        url: "/images/editorial/hero-burger.webp",
        width: 1800,
        height: 1200,
        alt: "ENZO smash burger",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ENZO — Smash Burgers & Fries",
    description: "Smashed fresh. Served hot.",
    images: ["/images/editorial/hero-burger.webp"],
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg" }],
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#7a1e1e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Restaurant",
  name: RESTAURANT.legalName,
  servesCuisine: ["Burgers", "American", "Fast food"],
  priceRange: "€€",
  telephone: RESTAURANT.phone,
  email: RESTAURANT.email,
  url: SITE_URL,
  image: `${SITE_URL}/images/editorial/hero-burger.webp`,
  slogan: RESTAURANT.tagline,
  address: {
    "@type": "PostalAddress",
    streetAddress: RESTAURANT.address.street,
    addressLocality: RESTAURANT.address.city,
    postalCode: RESTAURANT.address.postalCode,
    addressCountry: "SK",
  },
  openingHours: ["Mo-Th 11:00-21:00", "Fr-Sa 11:00-23:00", "Su 12:00-21:00"],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="sk" className={`${anton.variable} ${archivo.variable}`}>
      <head>
        {/* Bez JavaScriptu sa obsah odhalí okamžite — nič neostane skryté. */}
        <noscript>
          <style>{`[data-reveal]{opacity:1 !important;transform:none !important}`}</style>
        </noscript>
      </head>
      <body className="min-h-dvh antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
        <CartProvider>
          <a
            href="#obsah"
            className="no-print sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-full focus:bg-gold focus:px-5 focus:py-3 focus:font-sans focus:text-sm focus:font-bold focus:text-ink"
          >
            Preskočiť na obsah
          </a>
          <Header />
          <main id="obsah">{children}</main>
          <Footer />
          <CartDrawer />
          <MobileOrderBar />
          <CartToast />
        </CartProvider>
      </body>
    </html>
  );
}
