"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMenu } from "@/context/MenuContext";
import { CheckerRule } from "@/components/ui/Checkerboard";
import { CloseIcon } from "@/components/ui/Icons";
import { lockScroll, unlockScroll } from "@/lib/scrollLock";

/**
 * Oznam, ktorý vyskočí po otvorení webu.
 *
 * Text si píše prevádzka v admine. Kľúč v pamäti prehliadača je odvodený
 * od samotného textu — keď sa oznam zmení, ukáže sa aj tomu, kto ten
 * predošlý zavrel, a naopak ten istý oznam neotravuje pri každej návšteve.
 */
export function NoticeDialog() {
  const { notice, live } = useMenu();
  const [open, setOpen] = useState(false);

  const key = notice.enabled
    ? "enzo-oznam-" + hash(notice.title + "|" + notice.text)
    : null;

  useEffect(() => {
    if (!live || key === null) return;
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(key) === "1";
    } catch {
      // Súkromné okno alebo zakázané úložisko — oznam jednoducho ukážeme.
    }
    if (dismissed) return;
    // Krátka pauza, nech okno nepraští do tváre hneď pri načítaní.
    const t = window.setTimeout(() => setOpen(true), 600);
    return () => window.clearTimeout(t);
  }, [live, key]);

  useEffect(() => {
    if (!open) return;
    lockScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      unlockScroll();
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setOpen(false);
    if (key === null) return;
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      // nevadí, nabudúce sa ukáže znova
    }
  }

  if (!open) return null;

  return (
    <div
      className="no-print fixed inset-0 z-[90] flex items-end justify-center bg-ink/70 p-4 backdrop-blur-[2px] sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="oznam-nadpis"
        className="relative w-full max-w-md overflow-hidden rounded-2xl bg-cream shadow-2xl [animation:reveal_0.45s_cubic-bezier(0.16,1,0.3,1)_both]"
      >
        <div className="bg-burgundy px-6 pt-6 pb-5 text-cream">
          <p className="eyebrow text-gold">Novinka</p>
          <h2
            id="oznam-nadpis"
            className="mt-3 font-display text-[1.75rem] leading-[1.06] sm:text-[2.1rem]"
          >
            {notice.title}
          </h2>
        </div>
        <CheckerRule className="text-burgundy" size="0.5rem" />

        <div className="px-6 py-6">
          <p className="text-[1rem] leading-relaxed text-ink/75">{notice.text}</p>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {notice.cta.trim() !== "" && (
              <Link
                href="/#menu"
                onClick={close}
                className="inline-flex h-12 flex-1 items-center justify-center rounded-full bg-burgundy px-6 font-sans text-[0.78rem] font-extrabold tracking-[0.14em] text-cream uppercase transition-colors hover:bg-burgundy-700"
              >
                {notice.cta}
              </Link>
            )}
            <button
              type="button"
              onClick={close}
              className="inline-flex h-12 items-center justify-center rounded-full border-2 border-ink/15 px-6 font-sans text-[0.78rem] font-extrabold tracking-[0.14em] text-ink uppercase transition-colors hover:bg-ink/5"
            >
              Zavrieť
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={close}
          aria-label="Zavrieť oznam"
          className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full text-cream/80 transition-colors hover:bg-cream/15 hover:text-cream"
        >
          <CloseIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

/** Krátky odtlačok textu, aby sa zmenený oznam ukázal znova. */
function hash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
