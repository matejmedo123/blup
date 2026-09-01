import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import { ToastProvider } from "@/components/ui/Toast";

import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "CREW. — ľudia, ktorí držia event v pohybe",
    template: "%s · CREW.",
  },
  description:
    "Nábor, plánovanie smien, dochádzka, komunikácia a mzdy pre brigádnikov, dobrovoľníkov a stánkarov na festivaloch a eventoch.",
  applicationName: "CREW.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "CREW." },
  openGraph: {
    title: "CREW. — ľudia, ktorí držia event v pohybe",
    description: "Event crew management: prihlášky, smeny, check-in, správy, mzdy.",
    type: "website",
    locale: "sk_SK",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#111111",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sk" className={inter.variable}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[200] focus:rounded-10 focus:bg-ink focus:px-4 focus:py-2 focus:font-semibold focus:text-white"
        >
          Preskočiť na obsah
        </a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
