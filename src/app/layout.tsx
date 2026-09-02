import type { Metadata, Viewport } from "next";
import { Alfa_Slab_One, Archivo, Archivo_Black } from "next/font/google";
import { CartProvider } from "@/context/CartContext";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { MobileOrderBar } from "@/components/cart/MobileOrderBar";
import { CartToast } from "@/components/cart/CartToast";
import { RESTAURANT } from "@/lib/config";
import "./globals.css";

/** Wordmark ENZO — ťažký slab serif z brand boardu. */
const alfaSlab = Alfa_Slab_One({
  weight: "400",
  subsets: ["latin", "latin-ext"],
  variable: "--font-alfa",
  display: "swap",
});

/** Nadpisy, ceny, ceduľky — ťažký grotesk. */
const archivoBlack = Archivo_Black({
  weight: "400",
  subsets: ["latin", "latin-ext"],
  variable: "--font-archivo-black",
  display: "swap",
});

/** Bežný text a UI. */
const archivo = Archivo({
  subsets: ["latin", "latin-ext"],
  variable: "--font-archivo",
  display: "swap",
});

const SITE_URL = "https://enzo.sk";
const DESCRIPTION =
  "ENZO Smash Burgers & Pizza v Koniarovciach — smash burgery, pizza z vlastného cesta, domáce hranolky a stripsy. Objednaj online na osobný odber alebo rozvoz.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "ENZO — Smash Burgers & Pizza | Koniarovce",
    template: "%s | ENZO Koniarovce",
  },
  description: DESCRIPTION,
  applicationName: "ENZO",
  keywords: [
    "smash burger",
    "burger Koniarovce",
    "pizza Koniarovce",
    "rozvoz pizze Topoľčany",
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
    title: "ENZO — Smash Burgers & Pizza",
    description: DESCRIPTION,
    images: [
      {
        url: "/og.jpg",
        width: 1200,
        height: 630,
        alt: "ENZO Smash Burgers & Pizza — Koniarovce",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ENZO — Smash Burgers & Pizza",
    description: "Smashed fresh. Served hot.",
    images: ["/og.jpg"],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-96.png", sizes: "96x96", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
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
  servesCuisine: ["Burgers", "Pizza", "American", "Fast food"],
  priceRange: "€€",
  telephone: RESTAURANT.phone,
  email: RESTAURANT.email,
  url: SITE_URL,
  image: `${SITE_URL}/og.jpg`,
  slogan: RESTAURANT.tagline,
  address: {
    "@type": "PostalAddress",
    streetAddress: RESTAURANT.address.street,
    addressLocality: RESTAURANT.address.city,
    postalCode: RESTAURANT.address.postalCode,
    addressCountry: "SK",
  },
  openingHours: ["Mo-Th 11:00-21:00", "Fr-Sa 11:00-22:00", "Su 12:00-21:00"],
  hasMap: undefined,
  acceptsReservations: "False",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="sk" className={`${alfaSlab.variable} ${archivoBlack.variable} ${archivo.variable}`}>
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
