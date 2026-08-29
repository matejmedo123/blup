import type { LidAccent } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACCENTS: Record<LidAccent, { lid: string; text: string; ring: string }> = {
  cream: { lid: "bg-cream-200", text: "text-burgundy", ring: "ring-cream-400" },
  red: { lid: "bg-[#C42B1F]", text: "text-cream", ring: "ring-[#8E1D14]" },
  gold: { lid: "bg-gold", text: "text-burgundy-800", ring: "ring-gold-600" },
  burgundy: { lid: "bg-burgundy", text: "text-cream", ring: "ring-burgundy-800" },
};

/**
 * Grafické viečko omáčky podľa packagingu z brand boardu.
 * Vektorové riešenie namiesto fotky — ostré v každej veľkosti a plne on-brand.
 */
export function SauceLid({
  lines,
  accent,
  className,
}: {
  lines: [string, string];
  accent: LidAccent;
  className?: string;
}) {
  const a = ACCENTS[accent];
  return (
    <div className={cn("flex items-center justify-center", className)}>
      <div className="relative aspect-square w-[62%] max-w-40">
        {/* Telo kelímka */}
        <div className="absolute inset-x-[4%] bottom-[-13%] h-[52%] rounded-b-[45%] bg-cream-300 shadow-[inset_0_-10px_16px_-8px_rgba(0,0,0,0.28)]" />
        {/* Viečko */}
        <div
          className={cn(
            "absolute inset-0 flex flex-col items-center justify-center rounded-full ring-4 ring-inset",
            a.lid,
            a.ring,
          )}
          style={{
            boxShadow:
              "0 14px 26px -14px rgba(0,0,0,0.5), inset 0 -6px 14px -8px rgba(0,0,0,0.35)",
          }}
        >
          <span className={cn("font-display text-[1.05rem] leading-[0.95] sm:text-[1.25rem]", a.text)}>
            {lines[0]}
          </span>
          <span className={cn("font-display text-[1.05rem] leading-[0.95] sm:text-[1.25rem]", a.text)}>
            {lines[1]}
          </span>
        </div>
      </div>
    </div>
  );
}
