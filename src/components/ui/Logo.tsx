import { cn } from "@/lib/utils";

type LogoTone = "burgundy" | "cream" | "ink";

const TONE: Record<LogoTone, { text: string; checker: string; sub: string }> = {
  burgundy: { text: "text-burgundy", checker: "text-burgundy", sub: "text-burgundy" },
  cream: { text: "text-cream", checker: "text-cream", sub: "text-cream" },
  ink: { text: "text-ink", checker: "text-ink", sub: "text-ink" },
};

interface LogoProps {
  tone?: LogoTone;
  /** Veľkosť wordmarku v CSS jednotkách (font-size) */
  className?: string;
  /** Zobraziť riadok SMASH BURGERS & PIZZA so šachovnicou */
  withDescriptor?: boolean;
  /** Zobraziť ® */
  withMark?: boolean;
}

/**
 * ENZO wordmark postavený typograficky (Anton) — ostrý v každej veľkosti,
 * bez rasterových assetov. Presne kopíruje logiku z brand boardu:
 * wordmark + šachovnicové pravítko + descriptor.
 */
export function Logo({
  tone = "burgundy",
  className,
  withDescriptor = false,
  withMark = true,
}: LogoProps) {
  const t = TONE[tone];
  return (
    <span className={cn("inline-flex flex-col items-start leading-none", t.text, className)}>
      <span className="relative inline-flex items-start">
        <span
          className="font-slab leading-[0.86] tracking-[-0.005em]"
          style={{ fontSize: "1em" }}
        >
          ENZO
        </span>
        {withMark && (
          <span
            aria-hidden
            className="font-sans font-bold leading-none"
            style={{ fontSize: "0.19em", marginTop: "0.16em", marginLeft: "0.05em" }}
          >
            ®
          </span>
        )}
      </span>

      {withDescriptor && (
        <span
          className="mt-[0.16em] flex w-full items-center gap-[0.4em]"
          style={{ fontSize: "0.155em" }}
        >
          <span aria-hidden className={cn("checkerboard h-[1.05em] w-[2.4em] shrink-0", t.checker)}
            style={{ ["--checker-size" as string]: "0.55em" }}
          />
          <span className={cn("font-sans font-bold tracking-[0.2em] whitespace-nowrap", t.sub)}>
            SMASH BURGERS &amp; PIZZA
          </span>
          <span aria-hidden className={cn("checkerboard h-[1.05em] w-[2.4em] shrink-0", t.checker)}
            style={{ ["--checker-size" as string]: "0.55em" }}
          />
        </span>
      )}
    </span>
  );
}

/** Kruhový ENZO odznak z packagingu (wrap papier, badge na fotke). */
export function LogoBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex",
        "aspect-square flex-col items-center justify-center rounded-full bg-burgundy text-cream leading-none",
        className,
      )}
    >
      <span className="font-slab leading-none" style={{ fontSize: "0.3em" }}>
        ENZO
      </span>
      <span
        className="mt-[0.06em] text-center font-sans font-bold leading-[1.25] tracking-[0.14em]"
        style={{ fontSize: "0.085em" }}
      >
        SMASH
        <br />
        BURGERS
        <br />&amp; PIZZA
      </span>
    </span>
  );
}
