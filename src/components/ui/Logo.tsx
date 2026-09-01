import Link from "next/link";

import { cn } from "@/lib/cn";

/**
 * CREW. — bodka je súčasť značky. Nikdy ju nevynechávaj.
 */
export function Logo({
  href = "/",
  className,
  tone = "dark",
}: {
  href?: string | null;
  className?: string;
  tone?: "dark" | "light";
}) {
  const content = (
    <span
      className={cn(
        "text-[19px] leading-none font-extrabold tracking-[-0.04em]",
        tone === "light" ? "text-white" : "text-ink",
        className,
      )}
    >
      CREW<span className={tone === "light" ? "text-accent" : "text-accent-deep"}>.</span>
    </span>
  );
  if (!href) return content;
  return (
    <Link href={href} className="inline-flex items-center rounded-lg" aria-label="CREW. — domov">
      {content}
    </Link>
  );
}
