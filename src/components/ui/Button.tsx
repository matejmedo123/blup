import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Tlačidlá podľa prototypu: `dark` = #111, `accent` = #C7F36B, `outline` = biele
 * s 1px linkou, `quiet` = #F1F1EE, `ghost` = bez pozadia. Žiadne tiene.
 */
type Variant = "dark" | "accent" | "outline" | "quiet" | "ghost" | "danger" | "onDark" | "onAccent";
type Size = "sm" | "md" | "lg" | "block";

const VARIANTS: Record<Variant, string> = {
  dark: "bg-ink text-white hover:bg-body disabled:bg-ink/40",
  accent: "bg-accent text-ink hover:brightness-95 disabled:opacity-60",
  outline: "bg-surface text-ink border border-line-strong hover:bg-hover",
  quiet: "bg-subtle text-ink hover:bg-subtle-2",
  ghost: "bg-transparent text-muted hover:bg-subtle hover:text-ink",
  danger: "bg-bad-fg text-white hover:opacity-90 disabled:opacity-60",
  onDark: "bg-transparent text-white border border-white/28 hover:bg-white/10",
  onAccent: "bg-transparent text-ink border border-[rgba(17,17,17,0.3)] hover:bg-ink/5",
};

const SIZES: Record<Size, string> = {
  sm: "min-h-10 rounded-10 px-4 text-[13px] font-semibold gap-1.5",
  md: "touch rounded-12 px-[22px] py-[14px] text-[15px] font-semibold gap-2",
  lg: "rounded-12 px-[30px] py-[18px] text-base font-semibold gap-2",
  block: "w-full rounded-14 px-5 py-5 text-[17px] font-bold tracking-[0.02em] gap-2",
};

const BASE =
  "inline-flex items-center justify-center cursor-pointer transition-[background-color,opacity,filter] " +
  "duration-150 ease-out select-none disabled:cursor-not-allowed";

export type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  loading?: boolean;
  icon?: ReactNode;
};

export function Button({
  variant = "dark",
  size = "md",
  fullWidth,
  loading,
  icon,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export type ButtonLinkProps = ComponentPropsWithoutRef<typeof Link> & {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  icon?: ReactNode;
};

export function ButtonLink({
  variant = "dark",
  size = "md",
  fullWidth,
  icon,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link
      {...props}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)}
    >
      {icon}
      {children}
    </Link>
  );
}

/** Kruhové tlačidlo 44×44 — späť, zavrieť, odoslať. */
export function RoundButton({
  className,
  variant = "outline",
  children,
  ...props
}: ComponentPropsWithoutRef<"button"> & { variant?: "outline" | "dark" | "quiet" }) {
  const tones = {
    outline: "bg-surface border border-line-strong text-ink hover:bg-hover",
    dark: "bg-ink text-white hover:bg-body",
    quiet: "bg-subtle-2 text-ink hover:bg-subtle",
  };
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors duration-150",
        tones[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}
