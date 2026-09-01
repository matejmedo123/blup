import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Biela karta, 1px linka, radius 20. Bez tieňa — elevácia je kontrast. */
export function Card({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div {...props} className={cn("rounded-20 border border-line bg-surface", className)} />;
}

/** Tmavá karta — najdôležitejší obsah na obrazovke (najbližšia smena, KPI, zárobok). */
export function DarkCard({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div {...props} className={cn("rounded-20 bg-ink text-white", className)} />;
}

export function AccentCard({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div {...props} className={cn("rounded-20 bg-accent text-ink", className)} />;
}

export function SectionCard({
  label,
  action,
  children,
  className,
  bodyClassName,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-20 border border-line bg-surface p-5 sm:p-6", className)}>
      <div className="mb-[18px] flex items-center justify-between gap-3">
        <h2 className="section-label">{label}</h2>
        {action}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

type KpiTone = "dark" | "accent" | "plain";

/** KPI dlaždica admin dashboardu — hodnota 42px/800, nikdy sa nezalamuje. */
export function Kpi({
  label,
  value,
  note,
  tone = "plain",
  href,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: KpiTone;
  href?: string;
}) {
  const tones: Record<KpiTone, string> = {
    dark: "bg-ink text-white",
    accent: "bg-accent text-ink",
    plain: "bg-surface text-ink border border-line",
  };
  const inner = (
    <>
      <div className="text-[13px] opacity-70">{label}</div>
      <div className="mt-2 text-[34px] leading-none font-extrabold tracking-[-0.045em] whitespace-nowrap sm:text-[42px]">
        {value}
      </div>
      {note ? <div className="mt-2 text-[13px] opacity-55">{note}</div> : null}
    </>
  );
  const className = cn("block rounded-20 p-5 sm:p-[26px]", tones[tone], href && "transition-opacity hover:opacity-90");
  return href ? (
    <a href={href} className={className}>
      {inner}
    </a>
  ) : (
    <div className={className}>{inner}</div>
  );
}

/** Malá štatistická dlaždica (týždenný prehľad staffu, drawer). */
export function StatTile({
  value,
  label,
  tone = "plain",
}: {
  value: ReactNode;
  label: string;
  tone?: "plain" | "fill";
}) {
  return (
    <div
      className={cn(
        "rounded-14 p-4",
        tone === "fill" ? "bg-subtle-2" : "border border-line bg-surface",
      )}
    >
      <div className="text-[22px] leading-none font-bold tracking-[-0.02em]">{value}</div>
      <div className="mt-1.5 text-xs text-muted">{label}</div>
    </div>
  );
}

/** Zástupný blok za fotografiu — monospace popis toho, čo tu má byť. */
export function PhotoSlot({
  caption,
  tone = "light",
  className,
}: {
  caption: string;
  tone?: "light" | "dark";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-end p-4",
        tone === "dark" ? "photo-dark" : "photo-light",
        className,
      )}
    >
      <span
        className={cn(
          "font-mono text-[10px] tracking-[0.1em] uppercase",
          tone === "dark" ? "text-white/45" : "text-faint",
        )}
      >
        {caption}
      </span>
    </div>
  );
}
