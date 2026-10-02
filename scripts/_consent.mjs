/**
 * Odpoveď na cookies, aby ostatné testy merali to svoje.
 *
 * Okno so súhlasom je modálne — zakrýva stránku, kým naň človek neodpovie.
 * Tak to je navrhnuté a `smoke-cookies.mjs` presne to kontroluje. Pre každý
 * ĎALŠÍ test je to ale len dvere, ktoré treba otvoriť, než sa dá merať mapa
 * alebo prihlásenie; bez tohto hlásia „tlačidlo sa nedá kliknúť" a merajú
 * prekrytie namiesto svojej vlastnej veci.
 *
 * Odpovedá sa ZAMIETNUTÍM. Testy nemajú nič spúšťať u Mety ani Googlu a
 * zamietnutie je zároveň prísnejší stav — keď appka funguje s ním, s povolením
 * funguje tiež.
 *
 *   import { answerCookies } from './_consent.mjs';
 *   const ctx = await browser.newContext({ viewport });
 *   await answerCookies(ctx);
 */
export async function answerCookies(context) {
  await context.addInitScript(() => {
    try {
      globalThis.localStorage?.setItem('blup.cookies', JSON.stringify({
        v: 2,
        at: new Date().toISOString(),
        analytics: false,
        marketing: false,
        personalization: false,
      }));
      // Starý kľúč tiež — appka ho číta pri migrácii odpovede.
      globalThis.localStorage?.setItem('blup.marketing.consent', 'no');
    } catch {
      /* private mode */
    }
  });
}
