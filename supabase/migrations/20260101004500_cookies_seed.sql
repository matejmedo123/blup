-- ---------------------------------------------------------------------------
-- The cookie policy.
--
-- Written to describe what BLUP actually stores, not a template: the session,
-- the answer to the consent bar, and — only after a yes — the analytics of
-- whichever platforms the operator has configured. If nothing is configured,
-- nothing loads, and the document says so instead of implying otherwise.
--
-- Placeholders in {{...}} are the operator's own details, filled in from
-- Admin → Právne dokumenty by publishing a new version.
-- ---------------------------------------------------------------------------

insert into public.legal_documents (kind, version, locale, title, body, published_at)
values ('cookies', '1.0', 'sk', 'Zásady používania cookies', $doc$# Zásady používania cookies

**Prevádzkovateľ:** {{PREVADZKOVATEL}}
**Kontakt:** {{KONTAKT_EMAIL}}
**Účinné od:** {{DATUM}}

## Čo sú cookies a čo BLUP naozaj ukladá

Cookies sú malé súbory, ktoré si stránka odloží v tvojom prehliadači. BLUP
používa aj `localStorage` — technicky to nie je cookie, ale robí to isté, takže
sa na to vzťahuje to isté a je to popísané tu.

## 1. Nevyhnutné — bez týchto to nefunguje

| Čo | Načo | Ako dlho |
| --- | --- | --- |
| Prihlásenie | Aby si po obnovení stránky zostal prihlásený | Do odhlásenia |
| Košík a rezervácia | Aby ti vstupenky vydržali rezervované | 15 minút |
| Odpoveď na lištu o cookies | Aby sme sa nepýtali znova | 12 mesiacov |
| Vyrovnávacia pamäť obrazovky | Aby sa feed neťahal odznova pri každom kliknutí | Do zavretia karty |

Tieto nepotrebujú súhlas — bez nich by sa nedalo prihlásiť ani kúpiť vstupenku.
Vypnúť sa dajú len tak, že si v prehliadači zakážeš ukladanie údajov, čím
prestane fungovať prihlásenie.

## 2. Analytické a marketingové — len ak povieš áno

Ak má prevádzkovateľ nastavené meranie (Meta Pixel, Google Analytics alebo
Google Ads), spýtame sa ťa **skôr, než sa načíta čokoľvek z nich**. Do tej
chvíle sa nenačíta žiadny ich skript a neodošle sa žiadna udalosť — nič sa
nezaraďuje do fronty, ktorá by sa po súhlase odoslala naraz.

Ak nie je nastavené nič, nespúšťa sa nič a lišta sa ani neukáže.

## 3. Ako svoju odpoveď zmeníš

Kedykoľvek — dole na stránke klikni na **Aktualizovať nastavenia cookies**.
Lišta sa objaví znova a tvoja odpoveď sa prepíše. Odmietnutie znamená, že
meracie skripty sa prestanú načítavať; už odoslané údaje vieš riešiť cez
kontakt vyššie.

Cookies vieš zmazať aj priamo v prehliadači, v jeho nastaveniach súkromia.

## 4. Kto k údajom pristupuje

K nevyhnutným údajom pristupuje len BLUP a jeho poskytovateľ infraštruktúry
(Supabase) ako sprostredkovateľ. Analytické údaje spracúvajú Meta a Google ako
samostatní prevádzkovatelia podľa vlastných zásad — a len ak si súhlasil.

Podrobnosti o tom, aké osobné údaje spracúvame a prečo, nájdeš v dokumente
**Ochrana osobných údajov**.
$doc$, now())
on conflict (kind, version, locale) do nothing;
