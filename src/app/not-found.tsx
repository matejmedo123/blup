import Link from "next/link";
import { Logo } from "@/components/ui/Logo";

export default function NotFound() {
  return (
    <div className="container-enzo flex min-h-[70vh] flex-col items-center justify-center py-20 text-center">
      <Logo tone="burgundy" withDescriptor className="text-[3.5rem] sm:text-[5rem]" />
      <p className="mt-10 font-display text-[5rem] leading-none text-ink/12 sm:text-[8rem]">404</p>
      <h1 className="mt-2 font-display text-[2rem] leading-[1.05] text-ink sm:text-[2.8rem]">
        Táto stránka sa nesmashla
      </h1>
      <p className="mt-3 max-w-sm text-ink/55">
        Stránku sme nenašli. Zato vieme, kde nájdeš poriadny burger.
      </p>
      <Link
        href="/#menu"
        className="mt-8 inline-flex h-14 items-center rounded-full bg-burgundy px-8 font-sans text-[0.82rem] font-extrabold tracking-[0.14em] text-cream uppercase transition-colors hover:bg-burgundy-700"
      >
        Pozrieť menu
      </Link>
    </div>
  );
}
