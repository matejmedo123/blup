/**
 * Aký tvar má príbeh. Bez importov, zámerne.
 *
 * Rovnaký dôvod ako pri `imageCropMath` a `mapZoomMath`: appka podľa toho
 * kreslí rámček aj reže súbor a `scripts/check-story-frame.mjs` sa na to isté
 * pýta z Node-u. `storyFormat.ts` vedľa pridáva samotné orezávanie a to už
 * potrebuje `expo-image-manipulator`, ktorý v Node-e neexistuje — preto je
 * tvar tu a nie tam.
 *
 * Príbeh má jeden jediný rozmer: 1080 × 1920.
 *
 * Nie preto, že by iný tvar nešlo uložiť — ale preto, že príbeh sa pozerá na
 * celú obrazovku a všetko ostatné tam vyzerá ako chyba. Na výšku odfotená
 * fotka sedí, štvorec nechá hore aj dole čierny pás, fotka na šírku nechá pás
 * cez pol obrazovky. Keď je tvar jeden, nikto nikdy neuvidí pás.
 *
 * Preto sa tvar nerieši pri prehrávaní, ale pri vytváraní: každá fotka sa
 * oreže na 1080 × 1920 ešte predtým, než sa nahrá. Prehrávač potom nemá čo
 * dorovnávať — dostane presne to, čo vie zobraziť.
 */
export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;
/** 0,5625 — deväť ku šestnástim. */
export const STORY_ASPECT = STORY_WIDTH / STORY_HEIGHT;

/**
 * Najväčší rámček 9:16, ktorý sa zmestí do toho, čo je k dispozícii.
 *
 * Používa ho prehrávač, kamera aj editor, takže všetky tri ukazujú ten istý
 * výrez — čo zarámuješ, to uvidia ostatní.
 */
export function storyFrame(
  availableWidth: number,
  availableHeight: number,
): { width: number; height: number } {
  if (!(availableWidth > 0) || !(availableHeight > 0)) {
    return { width: 0, height: 0 };
  }
  // Na vysokej úzkej obrazovke obmedzuje šírka, na širokej výška.
  const byWidth = availableWidth / availableHeight <= STORY_ASPECT;
  return byWidth
    ? { width: availableWidth, height: availableWidth / STORY_ASPECT }
    : { width: availableHeight * STORY_ASPECT, height: availableHeight };
}
