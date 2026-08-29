import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "gold" | "outline" | "outline-cream" | "ghost" | "dark";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-burgundy text-cream hover:bg-burgundy-700 active:bg-burgundy-800 shadow-[0_2px_0_0_var(--color-burgundy-900)]",
  gold: "bg-gold text-ink hover:bg-gold-600 active:bg-gold-600 shadow-[0_2px_0_0_#8a6a12]",
  dark: "bg-ink text-cream hover:bg-ink-700 active:bg-ink-800",
  outline:
    "border-2 border-ink/85 text-ink hover:bg-ink hover:text-cream active:bg-ink-800",
  "outline-cream":
    "border-2 border-cream/80 text-cream hover:bg-cream hover:text-burgundy active:bg-cream-200",
  ghost: "text-ink hover:bg-ink/5",
};

const SIZES: Record<Size, string> = {
  sm: "h-10 px-4 text-[0.72rem] tracking-[0.14em]",
  md: "h-12 px-6 text-[0.8rem] tracking-[0.14em]",
  lg: "h-14 px-8 text-[0.9rem] tracking-[0.12em] sm:h-16 sm:px-10 sm:text-[0.95rem]",
};

const BASE =
  "inline-flex items-center justify-center gap-2.5 rounded-full font-sans font-extrabold uppercase " +
  "transition-[background-color,color,transform,box-shadow] duration-200 ease-out " +
  "active:translate-y-px disabled:pointer-events-none disabled:opacity-45 select-none";

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  fullWidth,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)}
      {...props}
    >
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends ComponentPropsWithoutRef<typeof Link> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  children: ReactNode;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  fullWidth,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)}
      {...props}
    >
      {children}
    </Link>
  );
}
