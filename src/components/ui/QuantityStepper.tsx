"use client";

import { cn } from "@/lib/utils";

interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Popis pre čítačky obrazovky, napr. "THE ENZO" */
  label: string;
  size?: "sm" | "md";
  tone?: "light" | "dark";
}

export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 99,
  label,
  size = "md",
  tone = "light",
}: QuantityStepperProps) {
  const dims =
    size === "sm" ? "h-10 w-10 text-lg" : "h-11 w-11 text-lg sm:h-12 sm:w-12 sm:text-xl";
  const box =
    tone === "dark"
      ? "border-cream/25 text-cream"
      : "border-ink/15 text-ink";
  const btn =
    tone === "dark"
      ? "hover:bg-cream/10 active:bg-cream/20 disabled:opacity-30"
      : "hover:bg-ink/5 active:bg-ink/10 disabled:opacity-30";

  return (
    <div
      className={cn("inline-flex items-center rounded-full border", box)}
      role="group"
      aria-label={`Množstvo — ${label}`}
    >
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label={`Znížiť množstvo — ${label}`}
        className={cn(
          "flex items-center justify-center rounded-full font-display transition-colors disabled:cursor-not-allowed",
          dims,
          btn,
        )}
      >
        <span aria-hidden>−</span>
      </button>
      <span
        aria-live="polite"
        className={cn(
          "min-w-7 text-center font-display tabular-nums sm:min-w-8",
          size === "sm" ? "text-base" : "text-lg",
        )}
      >
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        aria-label={`Zvýšiť množstvo — ${label}`}
        className={cn(
          "flex items-center justify-center rounded-full font-display transition-colors disabled:cursor-not-allowed",
          dims,
          btn,
        )}
      >
        <span aria-hidden>+</span>
      </button>
    </div>
  );
}
