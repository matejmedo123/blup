# Nasadenie na Websupport — krok za krokom

Návod pre človeka, ktorý s tým nemá skúsenosti. Celé to zaberie asi 20 minút.
Balík na nahratie je **`majales-web.zip`**.

---

## Čo budeš potrebovať

- Prístup do **Websupport administrácie** (admin.websupport.sk)
- Prístup k **FTP** alebo k Súborovému manažérovi vo Websupporte
- Doménu, na ktorej má web bežať (napr. `majalesnitra.sk`)

---

## 1. Vytvor databázu

1. V administrácii Websupportu otvor **Databázy → MySQL databázy**
2. Klikni **Vytvoriť databázu**
3. Vyplň:
   - **Názov**: napríklad `majales`
   - **Používateľ**: napríklad `majales`
   - **Heslo**: vygeneruj si silné a **hneď si ho niekam zapíš**
4. Ulož

Po vytvorení sa ti zobrazí **server databázy** — býva to `mariadb****.websupport.sk`
alebo `localhost`. Túto hodnotu budeš potrebovať v kroku 3.

> Zapíš si štyri údaje: **server, názov databázy, používateľ, heslo.**

---

## 2. Nahraj súbory

1. Rozbaľ `majales-web.zip` u seba v počítači
2. Pripoj sa cez FTP (alebo otvor **Súborový manažér** vo Websupporte)
3. Nahraj **obsah** rozbaleného priečinka do koreňa webu

Koreň webu je zvyčajne:

```
/www/domains/majalesnitra.sk/       ← hlavná doména
/www/domains/majalesnitra.sk/sub/   ← podstránky
```

**Pozor:** nahrávaj *obsah* priečinka, nie priečinok samotný. Po nahratí
musí byť `index.php` priamo v koreni webu, nie v podpriečinku.

Správne to vyzerá takto:

```
/www/domains/majalesnitra.sk/
├── index.php
├── install.php
├── config.example.php
├── admin/
├── api/
├── assets/
├── lib/
├── sql/
├── storage/
└── uploads/
```

---

## 3. Vyplň prístup k databáze

1. Premenuj `config.example.php` na **`config.php`**
   (v Súborovom manažéri: pravé tlačidlo → Premenovať)
2. Otvor `config.php` na úpravu a vyplň údaje z kroku 1:

```php
'db' => [
    'driver'   => 'mysql',
    'host'     => 'mariadb123.websupport.sk',   // server z kroku 1
    'port'     => 3306,
    'database' => 'majales',                     // názov databázy
    'username' => 'majales',                     // používateľ
    'password' => 'TVOJE_HESLO',                 // heslo
    'charset'  => 'utf8mb4',
],
```

3. O kúsok nižšie vyplň adresu webu a bezpečnostný kľúč:

```php
'app' => [
    'timezone' => 'Europe/Bratislava',
    'base_url' => 'https://www.majalesnitra.sk',  // bez lomky na konci!
    'app_key'  => 'sem_dlhy_nahodny_retazec',     // pozri nižšie
    'debug'    => false,
],
```

**Kde vziať `app_key`:** je to len dlhý náhodný reťazec. Buď si vymysli
64 náhodných znakov, alebo použi generátor hesiel. Slúži na podpisovanie
odhlasovacích odkazov z newslettera.

4. Ulož súbor

---

## 4. Nastav práva na priečinky

Dva priečinky musia byť **zapisovateľné**, inak sa nedajú nahrávať fotky:

| Priečinok | Práva |
|---|---|
| `uploads/` | **775** |
| `storage/` | **775** (aj podpriečinky `logs` a `mail`) |

V Súborovom manažéri: pravé tlačidlo na priečinok → **Práva** → zadaj `775`
a zaškrtni *aplikovať aj na podpriečinky*.

---

## 5. Spusti inštaláciu

1. Otvor v prehliadači **`https://tvojadomena.sk/install.php`**
2. Vyplň prihlasovacie meno a heslo pre správu webu
   (heslo aspoň 10 znakov — **zapíš si ho**, nedá sa obnoviť e-mailom)
3. Klikni **Nainštalovať**

Inštalátor vytvorí tabuľky, naplní ich textami a lineupom z návrhu
a založí tvoj účet.

### 6. Zmaž install.php

**Toto nezabudni.** Po úspešnej inštalácii zmaž zo servera súbor
`install.php`. Kým tam je, upozorňuje na to aj prehľad v admine.

---

## 7. Hotovo — čo ďalej

- **Web**: `https://tvojadomena.sk/`
- **Správa webu**: `https://tvojadomena.sk/admin/`

Prvé kroky v admine:

1. **Knižnica fotiek** → nahraj fotografie z minulých ročníkov
2. **Galéria**, **Interpreti**, **Zóny**, **Partneri** → priraď k nim fotky
3. **Nastavenia** → doplň odkazy na Facebook, Instagram a kontaktný e-mail
4. **Prehľad** → sekcia „Čo ešte doplniť" ti povie, čo ešte chýba

---

## Ako sa web mení

Všetko, čo je na webe vidieť, sa dá zmeniť v admine a je to na stránke
**okamžite** — nič sa nenahráva ani neprekladá.

| Chcem zmeniť | Kde v admine |
|---|---|
| Akýkoľvek text na stránke | **Texty na stránke** |
| Lineup, headliner, popisy kapiel | **Interpreti** |
| Ceny a typy vstupeniek | **Vstupenky** |
| Fotky v galérii | **Galéria** + **Knižnica fotiek** |
| Karty „Viac než koncerty" | **Zóny** |
| Otázky a odpovede | **Časté otázky** |
| Logá partnerov | **Partneri** |
| Dátumy, odkazy, sociálne siete, odpočet | **Nastavenia** |
| Kto má prístup do adminu | **Používatelia** |

### Keď chceš spustiť predaj vstupeniek

1. **Vstupenky** → pri každom type vyplň cenu
2. **Nastavenia** → *Spoločný odkaz na predaj* → vlož adresu predajného systému
3. **Prehľad** → prepínač **Predaj vstupeniek beží** → *Zapnúť*

Kým je prepínač vypnutý, na kartách svieti **ČOSKORO** a ceny sa neukážu,
aj keby už v databáze boli. Je to poistka, aby cena neunikla predčasne.

---

## Keď niečo nefunguje

### „Chýba config.php"
Nepremenoval si `config.example.php` na `config.php`, alebo je v inom
priečinku ako `index.php`.

### „Databáza je nedostupná"
Zle vyplnené údaje v `config.php`. Skontroluj najmä **server databázy** —
nie je to vždy `localhost`, Websupport často používa `mariadb****.websupport.sk`.

### Fotky sa nedajú nahrať
Priečinok `uploads/` nemá práva 775. Pozri krok 4.

### Stránka je biela
Otvor `storage/logs/php-error.log` — je tam napísané prečo.
Dočasne si môžeš v `config.php` prepnúť `'debug' => true`, aby sa chyba
vypísala priamo do stránky. **Po vyriešení to vráť späť na `false`.**

### E-maily neprichádzajú
Websupport niekedy blokuje funkciu `mail()`. V `config.php` prepni
posielanie na SMTP:

```php
'mail' => [
    'transport' => 'smtp',
    'from'      => 'web@majalesnitra.sk',
    'smtp' => [
        'host'       => 'smtp.websupport.sk',
        'port'       => 465,
        'encryption' => 'ssl',
        'username'   => 'web@majalesnitra.sk',   // celá e-mailová adresa
        'password'   => 'heslo_k_schranke',
    ],
],
```

### Zabudol som heslo do adminu
Heslo sa nedá obnoviť e-mailom. Musí ho prepísať iný správca
v sekcii **Používatelia**. Ak už nie je nikto, kto by sa dostal dnu,
ozvi sa — dá sa to prepísať priamo v databáze.

---

## Zálohovanie

Web má dve časti, ktoré treba zálohovať:

1. **Databáza** — texty, lineup, vstupenky, odberatelia
   Websupport: *Databázy → Export*. Odporúčam raz mesačne a vždy pred
   väčšou zmenou.
2. **Priečinok `uploads/`** — nahraté fotografie
   Stiahni si ho cez FTP.

Samotné súbory webu zálohovať netreba — tie sú v `majales-web.zip`.

---

## Aktualizácia webu na novšiu verziu

1. **Zálohuj databázu aj `uploads/`** (pozri vyššie)
2. Nahraj nové súbory cez FTP a nechaj prepísať staré
3. **Nikdy neprepisuj `config.php`** ani priečinok `uploads/`
4. Otvor web — prípadné zmeny v databáze sa dorobia samé

Obsah, ktorý si medzitým v admine napísal, sa aktualizáciou nestratí.

---

## Bezpečnosť — čo je už vyriešené

- Heslá sú v databáze len ako nečitateľný odtlačok (bcrypt)
- Prihlásenie sa po 8 neúspešných pokusoch na 15 minút zablokuje
- Formuláre sú chránené proti odoslaniu z cudzej stránky (CSRF)
- Všetky dotazy do databázy sú cez pripravené príkazy — SQL injection neprejde
- Nahraté fotky sa prekreslia cez GD, čím sa z nich odstráni prípadný
  skrytý kód aj údaje o polohe z EXIF
- V priečinku `uploads/` sa nedá spustiť PHP, aj keby sa tam nejaké dostalo
- Priečinky `lib/`, `sql/`, `storage/` a `config.php` nie sú dostupné
  z prehliadača
- Do adminu sa nedá dostať bez prihlásenia ani priamou adresou —
  kontroluje to server, nie len skrytie tlačidiel

### Čo si musíš ustrážiť ty

- **Zmaž `install.php`** po inštalácii
- Používaj **silné a jedinečné heslo** do adminu
- `config.php` nikdy nikomu neposielaj — sú v ňom prístupy k databáze
- Zapni na doméne **HTTPS certifikát** (Websupport ho dáva zadarmo);
  web sa naň presmeruje sám
