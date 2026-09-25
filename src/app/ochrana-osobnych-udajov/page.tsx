import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/LegalPage";
import { RESTAURANT } from "@/lib/config";

export const metadata: Metadata = {
  title: "Ochrana osobných údajov",
  description: "Informácie o spracovaní osobných údajov v ENZO Smash Burgers.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Ochrana osobných údajov"
      intro="Ako pracujeme s údajmi, ktoré nám zveríš pri objednávke."
      sections={[
        {
          heading: "Aké údaje spracúvame",
          body: [
            "Pri objednávke spracúvame meno, priezvisko, telefónne číslo, e-mail a — pri doručení — adresu doručenia. Tieto údaje potrebujeme výhradne na vybavenie objednávky.",
          ],
        },
        {
          heading: "Kde sú údaje uložené",
          body: [
            "Objednávka sa ukladá do našej databázy na hostingu, kde beží tento web. Prístup k nej má len prevádzka. Kópiu potvrdenia ti pošleme e-mailom.",
            "Tvoj prehliadač si ponechá obsah košíka a odkaz na poslednú objednávku, aby si sa k nej vedel vrátiť. Vymazať ich môžeš vymazaním údajov stránky v nastaveniach prehliadača.",
          ],
        },
        {
          heading: "Komu údaje odovzdávame",
          body: [
            "Pri platbe kartou spracúva platbu poskytovateľ platobnej brány; my sa k údajom o karte vôbec nedostaneme. Pri doručení odovzdáme meno, telefón a adresu osobe, ktorá objednávku privezie. Nikomu inému údaje neposkytujeme a nepoužívame ich na marketing.",
          ],
        },
        {
          heading: "Ako dlho ich uchovávame",
          body: [
            "Objednávky a doklady uchovávame po dobu, ktorú nám ukladajú účtovné predpisy. Potom ich odstránime alebo anonymizujeme.",
          ],
        },
        {
          heading: "Tvoje práva",
          body: [
            "Máš právo vedieť, aké údaje o tebe máme, žiadať ich opravu alebo vymazanie, a podať sťažnosť na Úrad na ochranu osobných údajov SR. Stačí sa nám ozvať.",
          ],
        },
        {
          heading: "Cookies",
          body: [
            "Web nepoužíva marketingové ani analytické cookies. Používame iba lokálne úložisko na uchovanie obsahu košíka a prihlásenia do administrácie.",
          ],
        },
        {
          heading: "Kontakt",
          body: [
            `S otázkami k spracovaniu údajov sa obráť na ${RESTAURANT.email} alebo ${RESTAURANT.phone}.`,
          ],
        },
      ]}
    />
  );
}
