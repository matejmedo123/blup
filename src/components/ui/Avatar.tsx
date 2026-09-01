import Image from "next/image";

import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";

const SIZES = {
  xs: "size-[34px] text-xs",
  sm: "size-9 text-xs",
  md: "size-11 text-sm",
  lg: "size-14 text-[17px]",
  xl: "size-16 text-xl",
} as const;

export function Avatar({
  firstName,
  lastName,
  src,
  size = "md",
  tone = "light",
  className,
}: {
  firstName: string;
  lastName: string;
  src?: string | null;
  size?: keyof typeof SIZES;
  /** `dark` = #111 s bielym textom (vlastný profil), `light` = #EFEFEB (zoznamy). */
  tone?: "light" | "dark";
  className?: string;
}) {
  const label = `${firstName} ${lastName}`.trim();
  if (src) {
    return (
      <Image
        src={src}
        alt={label}
        width={96}
        height={96}
        className={cn("shrink-0 rounded-full object-cover", SIZES[size], className)}
      />
    );
  }
  return (
    <span
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold",
        tone === "dark" ? "bg-ink text-white" : "bg-avatar text-ink",
        SIZES[size],
        className,
      )}
    >
      <span aria-hidden>{initials(firstName, lastName)}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
