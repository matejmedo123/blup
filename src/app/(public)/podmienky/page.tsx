import type { Metadata } from "next";

import { LegalPage, LegalSection } from "@/components/layout/LegalPage";

export const metadata: Metadata = {
  title: "Podmienky spolupráce",
  description: "Pravidlá práce cez CREW. — smeny, dochádzka, výplata.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Podmienky spolupráce" updated="1. 1. 2026">
      <LegalSection heading="Prihláška a schválenie">
        <p>
          Podanie prihlášky nezakladá nárok na smenu. Prihlášku posudzuje koordinátor eventu.
          Schválenie prihlášky ti otvorí prístup do portálu, ale samo o sebe neznamená pridelenie
          smeny.
        </p>
      </LegalSection>

      <LegalSection heading="Pridelenie a potvrdenie smeny">
        <p>
          Pridelená smena je návrh, kým ju nepotvrdíš. Potvrdenie je záväzné. Ak nemôžeš prísť,
          klikni v portáli na „Nemôžem prísť“ čo najskôr — koordinátor tak stihne nájsť náhradu.
          Zrušenie na poslednú chvíľu a neohlásená neúčasť znižujú Crew Score.
        </p>
      </LegalSection>

      <LegalSection heading="Dochádzka">
        <p>
          Odpracovaný čas vzniká z check-inu a check-outu v aplikácii. Ak sa nevieš checknúť
          (vybitý telefón, slabý signál), oslov koordinátora — check-in za teba urobí manuálne.
          Každá dodatočná oprava dochádzky sa zaznamenáva spolu s dôvodom a menom toho, kto ju
          vykonal.
        </p>
      </LegalSection>

      <LegalSection heading="Odmena">
        <p>
          Hodinová sadzba je uvedená pri každej smene ešte pred jej potvrdením. Odhad zárobku
          v portáli je orientačný a počíta sa z aktuálnej dochádzky. Vyplatená suma vychádza zo
          schválených dochádzkových údajov a môže sa od odhadu líšiť, ak bola dochádzka opravená.
        </p>
      </LegalSection>

      <LegalSection heading="Crew Score">
        <p>
          Crew Score je číslo od 0 do 100, ktoré sa mení podľa dochvíľnosti, potvrdzovania smien a
          hodnotení od koordinátorov. Pravidlá bodovania sú pre daný event rovnaké pre všetkých.
          Skóre je jedným z faktorov pri prideľovaní smien, nie jediným.
        </p>
      </LegalSection>

      <LegalSection heading="Ukončenie">
        <p>
          Účet si môžeš kedykoľvek nechať zmazať. Organizátor môže účet deaktivovať pri opakovanom
          porušovaní podmienok — už odpracované hodiny sa v takom prípade vyplatia v plnej výške.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
