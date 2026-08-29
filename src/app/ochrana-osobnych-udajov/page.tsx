import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/LegalPage";
import { RESTAURANT } from "@/lib/config";

export const metadata: Metadata = {
  title: "Ochrana osobných údajov",
  description: "Informácie o spracovaní osobných údajov v ENZO Smash Burgers & Fries.",
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
            "V tejto demo verzii sa objednávka ukladá výhradne do lokálneho úložiska (localStorage) vo tvojom prehliadači. Žiadne údaje sa neodosielajú na server ani tretím stranám.",
            "Údaje môžeš kedykoľvek odstrániť vymazaním údajov stránky v nastaveniach prehliadača.",
          ],
        },
        {
          heading: "Cookies",
          body: [
            "Web nepoužíva marketingové ani analytické cookies. Používame iba lokálne úložisko na uchovanie obsahu košíka medzi návštevami.",
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
