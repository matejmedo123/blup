/**
 * Zamknutie scrollu pre modálne vrstvy.
 * Kompenzuje šírku scrollbaru, aby stránka pri otvorení „neposkočila".
 * Počíta vnorené zámky (modal nad košíkom).
 */

let locks = 0;
let previousOverflow = "";
let previousPaddingRight = "";

export function lockScroll(): void {
  if (typeof document === "undefined") return;
  if (locks++ > 0) return;

  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  previousOverflow = document.body.style.overflow;
  previousPaddingRight = document.body.style.paddingRight;
  document.body.style.overflow = "hidden";
  if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
}

export function unlockScroll(): void {
  if (typeof document === "undefined") return;
  locks = Math.max(0, locks - 1);
  if (locks > 0) return;

  document.body.style.overflow = previousOverflow;
  document.body.style.paddingRight = previousPaddingRight;
}
