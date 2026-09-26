# BLUP SWAP

Ďalší predaj vstupeniek medzi dvoma ľuďmi. Samostatný produkt vnútri BLUPu —
vlastné hľadanie, vlastná logika, vlastné peniaze — ktorý do jadra BLUPu
zapisuje na jedinom mieste.

---

## Rozdiel, na ktorom všetko stojí

SWAP pozná dva druhy vstupeniek a **nikdy ich nemieša**, lebo o každej vie
niečo úplne iné.

### Overená BLUP vstupenka (`source = 'blup'`)

Vydali sme ju my. Riadok v `tickets` je náš, takže pri predaji:

1. prepíšeme `buyer_id` na kupujúceho,
2. vygenerujeme nový `code` aj nový `qr_secret`,
3. pôvodný prestane platiť.

Predajca sa s tým, čo má v telefóne, **dnu nedostane**. Toto je overiteľný
fakt, nie sľub — `test_55` ho dokazuje tým, že po prevode skúsi pôvodným
kódom prejsť pri vstupe a musí neprejsť.

### Vstupenka z inej platformy (`source = 'external'`)

Z Ticketportalu, Predpredaja, odkiaľkoľvek. Do ich databázy nevidíme, takže
**pravosť overiť nevieme a appka to netvrdí**. PDF môže byť dokonalý
falzifikát, alebo pravé, ale už predané trom ďalším ľuďom.

Čo vieme ponúknuť je ochrana peňazí: držíme ich, kým kupujúci nepotvrdí, že
vstupenka funguje. Ak nefunguje, vrátia sa mu.

> **Toto sa nesmie stratiť v texte ani v dizajne.** „Overená" je zelená a
> platí len pre prvý druh. Všetko ostatné je modrá „Chránená platba", čo je
> poctivejšie a menej. Rozhoduje o tom server (`authenticity` vo funkciách),
> nie obrazovka.

---

## Kde SWAP siaha do BLUPu

| | |
|---|---|
| Vlastné tabuľky | 9 |
| **Zapisuje do jadra** | **iba `tickets`** — prepis vlastníka a nový QR |
| Z jadra číta | `events`, `profiles`, `platform_settings`, `tickets` |
| Zdieľa ako hosť | stĺpec v `payments`, `notify_user`, nastavenia |

Ten jediný zápis je dôvod, prečo SWAP nie je oddelená appka. Keby ňou bol,
vstupenku previesť nevie — a „overená" by sa nedalo tvrdiť o ničom.

**Vypnutie:** `platform_settings.resale_enabled = false`. BLUP beží ďalej,
akoby SWAP nebol. Opačne to neplatí.

---

## Vlastné hľadanie

Nie je to hľadanie BLUPu s filtrom. Kladie inú otázku:

| | otázka | čo vracia | ako radí |
|---|---|---|---|
| **BLUP** | „čo sa deje?" | všetky nadchádzajúce eventy | čas, vzdialenosť |
| **SWAP** | „kde sa dá kúpiť od niekoho?" | len to, na čo niekto **práve** ponúka | počet ponúk, overené |

Event bez jedinej ponuky sa v SWAPe neobjaví — viedol by na prázdnu obrazovku.

```
swap_live_listings   pohľad na to, čo je živé (aktívne, neuplynulo, predajca nie je blokovaný)
swap_search()        hľadanie a poradie
swap_events_for()    z interpreta, mesta či miesta na jeho ponuky
```

Prázdny dotaz nie je chyba — je to prvé otvorenie, keď človek ešte nič
nenapísal. Vtedy sa ukáže všetko, čo je v ponuke.

---

## Cesta kupujúceho

```
hľadanie / stránka eventu
        ↓
ponuky na evente          event_resale_listings()
        ↓
pokladňa s rozpisom       quote_resale()        ← cenu určuje server
        ↓
podržanie vstupenky       reserve_resale_listing()
        ↓
platba                    resale-checkout / web-checkout
        ↓
zaplatené                 stripe-webhook → mark_resale_order_paid()
        ↓
  BLUP vstupenka: prevedená hneď, je medzi ostatnými
  externá:        predajca ju doručí, kupujúci potvrdí
        ↓
hotovo                    confirm_resale_ticket()
```

Kupujúci **musí pred zaplatením vidieť rozpis**, nie jedno číslo. Je to jediný
spôsob, ako si vie porovnať dve ponuky.

---

## Cesta predajcu

```
Predať vstupenku          create_resale_listing()
        ↓
v ponuke                  status = 'active'
        ↓
niekto platí              status = 'reserved'   ← drží to rezervácia
        ↓
predané                   status = 'sold'
        ↓
  BLUP vstupenka: hotovo, prevod prebehol sám
  externá:        doruč ju        deliver_resale_ticket()
        ↓
po evente vzniká nárok    settle_resale_orders()   ← cron
        ↓
výplata                   request_seller_payout() → resale-payout
```

**Peniaze nikdy neidú priamo predajcovi.** Pri platbe pristanú na účte
platformy a držia sa tam. Preto pri SWAPe zámerne **nie je destination charge**
— keby platba pristála u predajcu, nemali by sme čo vrátiť. Cena za to je, že
merchant of record je BLUP a spor z karty platí BLUP.

---

## Ochrana proti dvojpredaju

Dvaja ľudia klikajú „Kúpiť" v tej istej sekunde. Jeden ju dostať musí, druhý
nesmie. Držia to **dve veci naraz**:

1. `select ... for update` na riadku listingu — druhá transakcia počká.
2. Unikátny čiastočný index `resale_reservations_one_live` — aj keby sa prvá
   poistka obišla, databáza druhý živý záznam nepustí.

Prvé je rýchlosť, druhé je záruka. Samotný zámok by držal len dovtedy, kým
niekto nepridá druhú cestu k tej istej tabuľke.

---

## Peniaze

Vlastná kniha, nie tá organizátorská. Doterajšie výplaty patria
**organizácii** cez Stripe Connect; predajca na SWAPe je fyzická osoba, ktorá
žiadnu organizáciu nemá.

```
seller_accounts         účet u poskytovateľa (číslo účtu u nás nie je)
seller_ledger_entries   kniha zápisov — zostatok sa z nej POČÍTA
seller_payouts          výplaty
```

Zostatok sa počíta z knihy a neprepisuje sa v stĺpci. Prepisovaný zostatok sa
raz rozíde so skutočnosťou a nikto nezistí kedy.

**Kedy vzniká nárok**

| | |
|---|---|
| BLUP vstupenka | po evente + `resale_settlement_days` |
| externá | po evente + odklad, **a až keď kupujúci potvrdil** |

Otvorený spor nárok zadrží. Zrušený event zadrží všetko.

---

## Nastavenia

Všetko v `platform_settings`, meniteľné adminom bez zásahu do kódu:

| stĺpec | východzí | čo robí |
|---|---|---|
| `resale_enabled` | `true` | vypínač celého SWAPu |
| `resale_buyer_fee_bps` | **0** | poplatok kupujúceho, navrch |
| `resale_seller_fee_bps` | **1000 (10 %)** | provízia SWAPu, strháva sa predajcovi |
| `resale_price_cap_enabled` | **false** | vypínač stropu prirážky |
| `resale_max_markup_bps` | 0 | strop prirážky — uplatní sa len keď je zapnutý |
| `resale_hold_minutes` | 15 | ako dlho drží rezervácia |
| `resale_settlement_days` | 2 | koľko dní po evente sú peniaze k dispozícii |

### Cenu určuje predajca

**Strop je štandardne vypnutý.** Vstupenku vypíšeš za akúkoľvek cenu — nad aj
pod pôvodnou. Pôvodná cena sa uloží do `face_value_cents` a kupujúci ju vidí
ako informáciu („v predpredaji stála 40 €"), nie ako hranicu. To je celý zmysel
burzy; strop z nej robí len spôsob, ako sa vstupenky zbaviť.

Z databázy však strop nezmizol. V niektorých krajinách je limit prirážky nad
nominálnu hodnotu zákonná povinnosť, a keď tam BLUP pôjde, nemá sa to dopisovať
narýchlo: admin prepne `resale_price_cap_enabled` na `true` a
`resale_max_markup_bps` začne platiť. Vynútiť sa dá len pri BLUP vstupenke —
pri externej pôvodnú cenu nepoznáme, tam je `face_value_cents` údaj od
predajcu.

Spodná hranica **50 centov** platí vždy. Nie je to morálka, je to platobná
brána: nižšiu platbu Stripe odmietne a objednávka by uviazla v
`payment_pending` bez toho, aby ktokoľvek vedel prečo.

### Odporúčanie ceny

Prázdne pole „Cena" je pre predajcu rovnako zlá rada ako strop — netuší, či
pýta veľa alebo málo. Preto `resale_price_hint(event_id, ticket_id)` vráti trh
a tri návrhy:

| návrh | z čoho | komu |
|---|---|---|
| **Rýchly predaj** | tesne pod najlacnejšou cudzou ponukou | kto chce mať pokoj |
| **Vyvážená** | medián — predajov, ak ich je dosť, inak ponúk | väčšine |
| **Maximum** | horný kvartil ponúk | kto sa vie počkať |

Pri každom návrhu appka rovno ukáže, koľko z toho predajcovi príde po 10 %
provízii. Pod poľom s cenou beží hodnotenie napísanej sumy — „pod celým trhom",
„dobrá cena", „v hornej polovici", „nad celým trhom". **Nikdy to nie je zákaz.**
Nad trhom sa predávať smie; len to treba vedieť.

Dve veci, ktoré funkcia robí zámerne:

- **Vlastnú ponuku do trhu nepočíta.** Inak by si predajca radil sám sebe a
  odporúčanie by rástlo samo od seba.
- **Predajné ceny vydá až od troch predajov.** `resale_orders` vidí len
  kupujúci a predajca; funkcia je `security definer`, takže do nich vidí, a
  preto si sama stráži, aby sa z mediánu nedala dopočítať suma jedného človeka.
  Kým predajov nie je dosť, `sold.count` je 0 a rada stojí na živých ponukách.

### Provízia: 10 %, platí ju predajca

BLUP si zo SWAPu berie **10 % z ceny vstupenky**. Celú províziu nesie
predajca; kupujúci zaplatí presne toľko, koľko videl v ponuke.

```
ponuka          45,00 €
kupujúci platí  45,00 €      ← nič navyše
provízia SWAPu  − 4,50 €
predajca dostane 40,50 €
```

Prečo takto a nie 5 % + 5 %: rozdelená provízia znamená, že človek vidí v
zozname jednu cenu a v pokladni vyššiu. To je pri predaji vstupeniek tá
najnenávidenejšia vec a konkurencia ju rieši štítkom „no extra fees" priamo
v zozname. Cena v ponuke má byť cena, ktorú človek zaplatí.

Predajcu to neprekvapí: pri vypisovaní vidí rozpis „kupujúci zaplatí /
provízia / dostaneš" ešte predtým, než ponuku zverejní.

---

## Cron

```sql
blup-resale-holds    */2 * * * *   vypršané rezervácie a objednávky
blup-resale-settle   41 * * * *    komu už peniaze patria
blup-resale-payout   7 * * * *     skutočné odoslanie peňazí
```

Bez prvého by rezervácia držala vstupenku navždy. Funkcie si vypršanie
kontrolujú aj samy pri každom pohľade, takže kupujúci nevidí „rezervované"
dlhšie než treba — cron je upratovanie, nie ochrana.

---

## Čo ešte nie je hotové

- **Demo scenár z §41** ako test od začiatku do konca
- **Prevod externej vstupenky v appke pôvodnej platformy** je len poznámka od
  predajcu; overiť ho nevieme a netvárime sa, že vieme
- **Krajiny mimo SK** — `seller-connect` má natvrdo `SK` ako východziu krajinu
