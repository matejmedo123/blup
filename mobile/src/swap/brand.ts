/**
 * BLUP SWAP — ďalší predaj vstupeniek.
 *
 * Samostatný produkt vnútri BLUPu, nie jeho funkcia. Má vlastné hľadanie
 * (`swap_search`, ktoré sa pýta „kde sa dá niečo kúpiť", nie „čo sa deje"),
 * vlastné poradie výsledkov, vlastné peniaze a vlastné tabuľky. Do jadra
 * BLUPu zapisuje na jedinom mieste: prepisuje vlastníka vstupenky.
 *
 * Práve to jedno miesto je dôvod, prečo SWAP nie je oddelená appka. Keby ňou
 * bol, vstupenku previesť nevie — a „overená" by sa nedalo tvrdiť o ničom.
 *
 * Meno je tu ako konštanta a nie rozsypané po obrazovkách: keď sa raz zmení,
 * zmení sa na pätnástich miestach a na piatich zostane staré.
 *
 * `Blup Connect` sa použiť nedalo — to sú ľudia, ktorých možno poznáš.
 */
export const SWAP_BRAND = 'BLUP SWAP';

/** V strede vety, kde by verzálky kričali. */
export const SWAP_BRAND_INLINE = 'SWAP';

/**
 * Čo to je, jednou vetou — bez sľubov, ktoré nevieme splniť.
 *
 * „Overené" sa tu zámerne nespomína: platí to len pre vstupenky vydané
 * BLUPom a nesmie to znieť ako vlastnosť celého SWAPu.
 */
export const SWAP_TAGLINE =
  'Vstupenky od ľudí, ktorí nemôžu ísť. Peniaze držíme, kým nie je vstupenka u teba.';
