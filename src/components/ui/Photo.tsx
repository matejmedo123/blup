"use client";

import Image from "next/image";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface PhotoProps {
  /** Cesta na fotku. Prázdna hodnota znamená „fotku nemáme“. */
  src?: string | null;
  alt: string;
  sizes: string;
  className?: string;
  priority?: boolean;
  loading?: "lazy" | "eager";
  /** Malý náhľad (košík) — náhrada musí byť drobnejšia. */
  compact?: boolean;
}

/**
 * Fotka, ktorá sa nikdy nepokazí na pohľad.
 *
 * Cesta v databáze môže ukazovať na súbor, ktorý na serveri nie je — po
 * neúplnom prenose cez FTP alebo po premenovaní. Prehliadač na to odpovie
 * modrým otáznikom, čo na karte burgra vyzerá ako pokazený web. Namiesto
 * toho ukážeme vlastnú náhradu v brandových farbách; vyzerá to zámerne
 * a zákazník sa nemá čoho zľaknúť.
 *
 * Vypĺňa celú plochu rodiča (`fill`), takže rodič musí byť `relative`.
 */
export function Photo({
  src,
  alt,
  sizes,
  className,
  priority,
  loading,
  compact = false,
}: PhotoProps) {
  // Pamätáme si konkrétnu cestu, ktorá zlyhala — po výmene fotky
  // sa to má skúsiť odznova.
  const [failed, setFailed] = useState<string | null>(null);
  const path = (src ?? "").trim();

  if (path === "" || failed === path) {
    return <PhotoFallback compact={compact} />;
  }

  return (
    <Image
      src={path}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      loading={loading}
      className={className}
      onError={() => setFailed(path)}
    />
  );
}

/** Náhrada namiesto chýbajúcej fotky — pokojná plocha so značkou. */
function PhotoFallback({ compact }: { compact: boolean }) {
  return (
    <div
      aria-hidden
      className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-cream-200 to-cream-300"
    >
      <span
        className={cn(
          "font-slab leading-[1.02] text-burgundy/20",
          compact ? "text-[0.72rem]" : "text-[1.5rem] sm:text-[2rem]",
        )}
      >
        ENZO
      </span>
      {!compact && (
        <span
          className="checkerboard absolute inset-x-0 bottom-0 h-4 text-burgundy/20"
          style={{ ["--checker-size" as string]: "0.5rem" }}
        />
      )}
    </div>
  );
}
