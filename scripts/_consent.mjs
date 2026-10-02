/**
 * Prvé spustenie odbavené, aby ostatné testy merali to svoje.
 *
 * BLUP víta nového návštevníka dvoma vrstvami, ktoré zakryjú stránku, kým na
 * ne neodpovie: krátkou prehliadkou („Čo sa deje okolo teba — Ďalej /
 * Preskočiť") a oknom so súhlasom s cookies. Obe sú tak navrhnuté a obe majú
 * vlastný test — prehliadku `smoke-navigation.mjs`, súhlas `smoke-cookies.mjs`.
 *
 * Pre každý ĎALŠÍ test sú to len dvere, ktoré treba otvoriť, než sa dá merať
 * mapa alebo prihlásenie. Bez tohto hlásia „tlačidlo sa nedá kliknúť" a merajú
 * prekrytie namiesto svojej vlastnej veci.
 *
 * Cookies sa odpovedajú ZAMIETNUTÍM. Testy nemajú nič spúšťať u Mety ani
 * Googlu a zamietnutie je zároveň prísnejší stav: keď appka funguje s ním, s
 * povolením funguje tiež.
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
      // Úvodná prehliadka. Je to modálne okno cez celú stránku, takže bez
      // tohto sa pod ním nedá kliknúť na nič.
      globalThis.localStorage?.setItem('blup.welcome.v1.seen', '1');
    } catch {
      /* private mode */
    }
  });
}
