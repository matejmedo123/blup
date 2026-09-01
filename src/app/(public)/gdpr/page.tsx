import type { Metadata } from "next";

import { LegalPage, LegalSection } from "@/components/layout/LegalPage";

export const metadata: Metadata = {
  title: "Ochrana osobných údajov",
  description: "Aké údaje CREW. spracúva, prečo a ako dlho.",
};

export default function GdprPage() {
  return (
    <LegalPage title="Ochrana osobných údajov" updated="1. 1. 2026">
      <LegalSection heading="Aké údaje zbierame">
        <p>
          Zbierame len to, čo potrebujeme na nábor, plánovanie smien a výplatu: meno, priezvisko,
          e-mail, telefón, rok narodenia, mesto, pracovné skúsenosti, preferované pozície a
          dostupnosť. Pri check-ine ukladáme čas a — ak je zapnutá kontrola polohy a ty ju povolíš —
          aj GPS súradnice v okamihu check-inu.
        </p>
        <p>
          Nezbierame rodné číslo, číslo občianskeho preukazu ani údaje o zdravotnom stave.
        </p>
      </LegalSection>

      <LegalSection heading="Prečo ich spracúvame">
        <p>
          Na základe tvojho súhlasu a na plnenie dohody o práci: aby sme ti vedeli prideliť smenu,
          spočítať odpracované hodiny a vyplatiť ťa. Kontaktné údaje používame na prevádzkové
          správy o smenách — nie na marketing.
        </p>
      </LegalSection>

      <LegalSection heading="Kto sa k nim dostane">
        <p>
          Koordinátor eventu vidí tvoj profil, smeny a dochádzku. Prístup k mzdovým údajom má len
          admin alebo koordinátor s výslovne udeleným oprávnením. Každý zásah do dochádzky a mzdy
          je zaznamenaný v audit logu.
        </p>
      </LegalSection>

      <LegalSection heading="Ako dlho ich držíme">
        <p>
          Profil a prihlášky uchovávame, kým máš účet. Mzdové podklady držíme po dobu vyžadovanú
          účtovnými predpismi. Prihlášky dobrovoľníkov a stánkarov mažeme rok po skončení eventu,
          ak nepokračuje spolupráca.
        </p>
      </LegalSection>

      <LegalSection heading="Tvoje práva">
        <p>
          Máš právo na prístup k údajom, ich opravu, výmaz a prenositeľnosť. V portáli si vieš
          stiahnuť všetky svoje údaje ako súbor a požiadať o zmazanie účtu. Súhlas môžeš kedykoľvek
          odvolať — spracovanie do jeho odvolania tým nie je dotknuté.
        </p>
        <p>
          Ak máš pocit, že s tvojimi údajmi narábame nesprávne, môžeš sa obrátiť na Úrad na ochranu
          osobných údajov SR.
        </p>
      </LegalSection>

      <LegalSection heading="Bezpečnosť">
        <p>
          Heslá ukladáme výhradne ako scrypt hash, nikdy v čitateľnej podobe. Prihlasovacie relácie
          sú viazané na náhodný token, ktorý je v databáze uložený len ako hash. Prístup k údajom je
          riadený rolami a oprávneniami a každá citlivá operácia sa loguje.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
