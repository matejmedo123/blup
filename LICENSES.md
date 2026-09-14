# Licencie závislostí

Stav k auditu z 14. 9. 2026. Prever príkazom:

```bash
node scripts/check-licenses.mjs          # zlyhá pri AGPL alebo GPL v runtime
node scripts/check-licenses.mjs --list   # rozpis podľa licencie
```

## Výsledok

**634 balíkov v `mobile/`. Žiadna AGPL. Žiadna GPL v tom, čo sa distribuuje.**

| Licencia | Balíkov |
|---|---|
| MIT | 543 |
| ISC | 31 |
| Apache-2.0 | 15 |
| BSD-2-Clause | 11 |
| BSD-3-Clause | 9 |
| BlueOak-1.0.0 | 6 |
| MIT OR CC0-1.0 | 3 |
| MPL-2.0 | 3 |
| MIT AND OFL-1.1 | 2 |
| Unlicense | 2 |
| 0BSD | 2 |
| ostatné (po jednom) | 5 |
| **bez uvedenej licencie** | **0** |

Nula balíkov bez uvedenej licencie je to najlepšie, čo z takéhoto auditu môže
vyjsť — práve nedohľadateľná licencia býva pri due diligence problém, nie
prísna licencia.

## Čo si treba všimnúť

### MPL-2.0 — `lightningcss` (3 balíky)

Súborový copyleft: podmienka sa viaže na **konkrétny zdrojový súbor**, nie na
celý produkt. Používať v uzavretom projekte sa smie. Jediná povinnosť by
nastala, keby si upravil priamo zdrojáky lightningcss — potom musia tie upravené
súbory zostať otvorené. Nerobíme to; je to build-time nástroj na CSS.

**Nič netreba riešiť.**

### `node-forge` — `(BSD-3-Clause OR GPL-2.0)`

Duálna licencia, vyberáš si. Berieme **BSD-3-Clause**. Skript takéto prípady
rozpoznáva a neoznačuje ich.

### Fonty — SIL OFL 1.1

- `@expo-google-fonts/nunito`
- `@expo-google-fonts/jetbrains-mono`

Dokument o nastavení firmy varuje, že webfont licencia býva samostatná a
systematicky sa prehliada. Tu je v poriadku: **OFL výslovne povoľuje
komerčné použitie aj vloženie fontu do aplikácie**, zadarmo a bez licenčného
poplatku. Podmienky sú dve a ani jednu neporušujeme:

1. font sa nesmie predávať samostatne (nepredávame ho),
2. upravený font nesmie niesť pôvodný názov (Reserved Font Name) — fonty
   neupravujeme.

Fonty sú súčasťou balíka, nenačítavajú sa z cudzieho servera, takže
nepribúda ani závislosť na tretej strane, ani GDPR otázka okolo Google Fonts.

### `caniuse-lite` — CC-BY-4.0

Databáza podpory prehliadačov. Build-time, do buildu sa nedostane.
CC-BY vyžaduje uvedenie autora pri **šírení samotnej databázy**, čo nerobíme.

## Ako skript rozlišuje

Tri rodiny licencií sa správajú inak, lebo BLUP sa distribuuje dvomi spôsobmi
naraz — ako web, ktorý si ktokoľvek načíta, a ako aplikácia v dvoch obchodoch:

| Rodina | Čím sa aktivuje | Čo s tým skript robí |
|---|---|---|
| **AGPL** | poskytovaním softvéru **cez sieť** | **zlyhá** — jeden balík zaväzuje zverejniť zdroják celej služby |
| **GPL / LGPL** | **distribúciou** — a build v App Store ňou je | **zlyhá**, ak je balík v runtime |
| **MPL / EPL / CDDL** | úpravou konkrétneho súboru | nahlási, nezlyhá |

Skript odlišuje `▲ runtime` od nástrojov pri builde: GPL nástroj, ktorý sa
nikam nedistribuuje, nie je to isté, čo GPL knižnica v aplikácii.

Overené, že audit vie zlyhať: podstrčený balík s `AGPL-3.0` a druhý s `GPL-3.0`
v `dependencies` → obidva zachytené, návratový kód 1.

## Čo tento audit nepokrýva

- **Edge Functions (Deno).** Importy sú v `supabase/functions/*/deno.json`;
  `_shared/stripe.ts` je písaný bez závislostí zámerne, takže plocha je malá —
  ale prejdi si ju, keď pribudne knižnica.
- **Obrázky, ikony a ilustrácie.** Licencie k nim nie sú v `package.json`.
- **Kód od tretích osôb.** Grafik, freelancer, kamarát — to je sekcia 2
  dokumentu o nastavení, nie strojová kontrola. Najčastejší nález pri due
  diligence nie je zlá licencia knižnice, ale chýbajúca zmluva s človekom.
