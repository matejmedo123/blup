/**
 * Kde na príbehu text sedí a aký je veľký. Bez importov, zámerne.
 *
 * Ten istý dôvod ako pri `storyShape` a `imageCropMath`: na tieto čísla sa
 * pýta editor (pri písaní), kamera (pri fotení) aj prehrávač (pri pozeraní),
 * a `scripts/check-story-frame.mjs` sa na ne pýta z Node-u. Keby mala každá
 * obrazovka vlastnú matematiku, text by pristál inde, než kam ho človek dal —
 * a presne to sa aj dialo: editor kreslil text na 42 % výšky, ukladal 50 % a
 * prehrávač ho nakreslil na 50 %. Rozdiel bol vidieť, príčina nie.
 *
 * Dve veci, ktoré tie čísla musia splniť:
 *
 *   1. Poloha je ZLOMOK rámčeka, nie body. Rámček má v editore inú veľkosť
 *      než na telefóne pri pozeraní; body by znamenali iné miesto.
 *
 *   2. Veľkosť písma je tiež zlomok. Pevných 26 bodov zaberá v malom rámčeku
 *      pol obrazovky a vo veľkom pásik — text by pristál správne, ale vyzeral
 *      by inak.
 */

/** Stred textu, ako zlomok šírky a výšky rámčeka. */
export interface OverlaySpot {
  x: number;
  y: number;
}

export type OverlayTextSize = 's' | 'm' | 'l';

/**
 * Veľkosť písma ako zlomok ŠÍRKY rámčeka.
 *
 * Šírky a nie výšky: na 9:16 je to jedno, ale keby sa raz pomer zmenil,
 * písmo viazané na výšku by na širšom tvare zrazu narástlo.
 *
 * Čísla sú zvolené tak, aby v doterajšom rámčeku (~320 bodov na šírku) vyšli
 * na 18 / 26 / 36 bodov — teda presne to, čo appka kreslila doteraz.
 */
export const OVERLAY_SIZE_RATIO: Record<OverlayTextSize, number> = {
  s: 0.056,
  m: 0.081,
  l: 0.113,
};

/** Riadkovanie. Menšie písmo znesie tesnejšie riadky než veľké. */
const LINE_RATIO = 1.22;

/**
 * Najširší text: 86 % rámčeka. Zvyšok je okraj, aby text nesedel na hrane.
 */
export const OVERLAY_MAX_WIDTH = 0.86;

/**
 * Dokiaľ sa dá text ťahať.
 *
 * Nie až k okraju: text zastavený presne na hrane je z polovice mimo a nedá
 * sa prečítať. Zvislo je priestoru viac, lebo hore aj dole je len okraj —
 * vodorovne treba nechať miesto na samotný text.
 */
export const OVERLAY_BOUNDS = { minX: 0.2, maxX: 0.8, minY: 0.08, maxY: 0.92 };

export function clampSpot(spot: Partial<OverlaySpot> | null | undefined): OverlaySpot {
  const x = typeof spot?.x === 'number' && Number.isFinite(spot.x) ? spot.x : 0.5;
  const y = typeof spot?.y === 'number' && Number.isFinite(spot.y) ? spot.y : 0.5;
  return {
    x: Math.min(OVERLAY_BOUNDS.maxX, Math.max(OVERLAY_BOUNDS.minX, x)),
    y: Math.min(OVERLAY_BOUNDS.maxY, Math.max(OVERLAY_BOUNDS.minY, y)),
  };
}

/**
 * Aký široký smie byť text, keď je jeho stred na `x`.
 *
 * Symetricky okolo stredu, takže text nikdy nepretečie okraj — a to bez toho,
 * aby ho bolo treba najprv odmerať. Ťahaním do strany sa text zúži a zalomí
 * do viacerých riadkov; to je jediný spôsob, ako môže byť „vľavo" a zároveň
 * celý vidno.
 */
export function overlayWidthAt(x: number): number {
  const spot = clampSpot({ x, y: 0.5 });
  return Math.min(OVERLAY_MAX_WIDTH, 2 * Math.min(spot.x, 1 - spot.x));
}

/** Písmo a riadkovanie v bodoch pre daný rámček. */
export function overlayType(
  size: OverlayTextSize | undefined,
  frameWidth: number,
): { fontSize: number; lineHeight: number } {
  const ratio = OVERLAY_SIZE_RATIO[size ?? 'm'] ?? OVERLAY_SIZE_RATIO.m;
  // Spodná hranica je proti nule pri rámčeku, ktorý ešte nebol odmeraný;
  // bez nej by React Native dostal fontSize 0 a text by zmizol.
  const fontSize = Math.max(8, Math.round(ratio * Math.max(1, frameWidth)));
  return { fontSize, lineHeight: Math.round(fontSize * LINE_RATIO) };
}
