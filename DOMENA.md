# blup.sk — doména, hosting a e-mail

Máš doménu cez **Websupport**. Tento návod ju napojí na web, rozbehne odosielanie
vstupeniek a založí schránku `ahoj@blup.sk`.

Čítaj to ako pokračovanie [SPUSTENIE.md](SPUSTENIE.md) — tam je Supabase, Stripe
a build; tu je všetko, čo súvisí s doménou.

---

## Najprv rozhodnutie: kde bude hosting

Máš dve rozumné možnosti a jednu, ktorá sa neoplatí.

### Vercel — odporúčam

Statický export nahráš jedným príkazom, HTTPS certifikát si vypýta a obnovuje
sám, obsah servíruje z uzlov po Európe a každé nasadenie má vlastnú adresu, na
ktorej si zmenu pozrieš pred spustením naostro. Na tvoj objem **zdarma**.

Nevýhoda: je to ďalšia firma a ďalší účet.

### Websupport — dá sa, a otestoval som to

Máš tam doménu, tak môžeš mať aj hosting. Beží na Apache, a `.htaccess`, ktorý
build vygeneruje, som **naozaj vyskúšal** na Apachi — statické adresy, dynamické
(`/event/<id>`), statické súbory aj stránka 404 fungujú tak, ako majú.

Prakticky to znamená: nahráš obsah priečinka `mobile/dist` do `web/` cez FTP a
je to. Nevýhoda oproti Vercelu je, že nasadzuješ ručne a nemáš náhľad pred
spustením.

### Čo nerobiť

Nekupuj si kvôli tomu VPS. Nie je čo spravovať — je to priečinok so súbormi.

---

## 1. DNS vo Websupporte

Prihlás sa na [admin.websupport.sk](https://admin.websupport.sk) →
**Domény → blup.sk → DNS záznamy**.

Ako to funguje, aby si vedel, čo robíš:

| Typ | Na čo je |
| --- | --- |
| **A** / **CNAME** | kam ide prehliadač, keď napíše blup.sk |
| **MX** | kam chodí pošta, ktorú ti niekto **pošle** |
| **TXT** (SPF, DKIM) | kto smie **odosielať** poštu v mene blup.sk |

Sú to tri nezávislé veci. Web môže byť na Verceli, pošta vo Websupporte a
vstupenky môže rozposielať Resend — naraz a bez konfliktu.

### Ak ideš na Vercel

Vo Verceli **Settings → Domains → Add** zadaj `blup.sk`. Vypíše ti presné
hodnoty — použi tie, nie tie moje; občas ich menia. Typicky to sú:

| Typ | Názov | Hodnota | TTL |
| --- | --- | --- | --- |
| A | `@` | `76.76.21.21` | 3600 |
| CNAME | `www` | `cname.vercel-dns.com` | 3600 |

Vo Websupporte je pole „Názov" prázdne alebo `@` pre samotnú doménu.

### Ak ostávaš vo Websupporte

Nastavuje sa to samo pri založení hostingu — A záznam bude ukazovať na ich
server. Nič nepridávaš.

### Overenie

```bash
dig +short blup.sk
dig +short www.blup.sk
```

Zmena sa prejaví do pár minút, občas do hodiny. Kým sa neprejaví, nemá zmysel
nič ďalšie riešiť.

---

## 2. Nasadenie webu

### Vercel

```bash
cd mobile
npm run build:web
npm i -g vercel
cd dist && vercel --prod
```

Pri prvom spustení sa opýta na projekt; potom už len `vercel --prod`.
Konfiguráciu presmerovaní (`vercel.json`) si vezme z priečinka sám.

### Websupport

```bash
cd mobile
npm run build:web
```

Obsah `mobile/dist` nahraj cez FTP (údaje sú v administrácii pod
**Hosting → FTP prístupy**) do priečinka `web/`. Nahrávaj **obsah**, nie
priečinok `dist` — v `web/` má priamo ležať `index.html`.

**Nezabudni na `.htaccess`** — je v `dist`, ale FTP klienti súbory začínajúce
bodkou často skrývajú. Bez neho vráti `/event/<id>` chybu 404. V FileZille to je
Server → *Vynútiť zobrazenie skrytých súborov*.

V administrácii ešte zapni **Let's Encrypt certifikát** a presmerovanie na HTTPS.

---

## 3. E-mail — dve rôzne veci

Toto sa najčastejšie mieša dokopy, tak nadvakrát.

### 3a. Schránka, do ktorej ti ľudia píšu

`ahoj@blup.sk`, `podpora@blup.sk`. Websupport ju vie a je to najjednoduchšie —
máš tam doménu, MX záznamy si nastaví sám.

**Hosting → E-mail → Pridať schránku.** Pár eur mesačne, hotovo za pár minút.

Alternatívy, ak chceš viac: **Google Workspace** (~6 €/používateľ/mesiac,
kalendár a disk navyše) alebo **Zoho Mail** (má aj vlastnú doménu zdarma pre
jedného používateľa). Vtedy MX záznamy prepíšeš na tie ich.

### 3b. Odosielanie vstupeniek

Toto **nesmieš** riešiť schránkou. Keby appka posielala tisíce vstupeniek cez
obyčajný SMTP, skončí v spame a poskytovateľ ti to zastaví.

Na to je **[Resend](https://resend.com)** — 3 000 e-mailov mesačne zdarma, čo je
pri jednom e-maile na objednávku dosť na prvé mesiace.

1. Založ účet a daj **Domains → Add domain → `blup.sk`**.
2. Ukáže ti tri až štyri záznamy. Pridaj ich vo Websupporte presne tak, ako
   ich vypíše:

| Typ | Názov | Hodnota | Poznámka |
| --- | --- | --- | --- |
| TXT | `resend._domainkey` | `p=MIGfMA0…` (dlhý reťazec) | DKIM — podpis |
| TXT | `@` alebo `send` | `v=spf1 include:amazonses.com ~all` | SPF — povolenie |
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` (priorita 10) | odrazy |

3. Počkaj na zelené **Verified** (minúty až hodiny).
4. **API Keys → Create**, kľúč do `supabase/.env`:

```bash
RESEND_API_KEY=re_...
EMAIL_FROM=Blup <vstupenky@blup.sk>
EMAIL_REPLY_TO=ahoj@blup.sk
```

> **Pozor na SPF, ak máš aj schránku.** SPF záznam smie byť pre doménu **len
> jeden**. Ak už máš `v=spf1 include:websupport.sk ~all` a Resend chce svoj,
> **nepridávaj druhý riadok** — spoj ich do jedného:
> ```
> v=spf1 include:websupport.sk include:amazonses.com ~all
> ```
> Dva samostatné SPF záznamy sú horšie než žiadny: overovanie zlyhá na oboch.
>
> Ak ti Resend ponúkne subdoménu (`send.blup.sk`), vezmi ju — má vlastný SPF a
> tento problém úplne obíde.

---

## 4. Prepíš doménu v aplikácii

Na štyroch miestach. Keď trafíš tri zo štyroch, platba sa vráti niekam inam.

```bash
# supabase/.env
APP_PUBLIC_URL=https://blup.sk
STRIPE_CONNECT_RETURN_URL=https://blup.sk/organizer/payouts
STRIPE_CONNECT_REFRESH_URL=https://blup.sk/organizer/payouts

# mobile/.env
EXPO_PUBLIC_WEB_URL=https://blup.sk
```

Supabase → **Authentication → URL Configuration**:

- Site URL: `https://blup.sk`
- Redirect URLs: `https://blup.sk/auth/callback`, `https://blup.sk/auth/reset-password`

Stripe → webhook necháš, ten ide na Supabase, nie na tvoju doménu.

Potom:

```bash
npx supabase secrets set --env-file supabase/.env   # po zmene supabase/.env
cd mobile && npm run build:web                      # po zmene mobile/.env
```

---

## 5. Otestuj, že to naozaj beží

```bash
node scripts/smoke-web.mjs https://blup.sk
./scripts/probe-security.sh https://<project-ref>.supabase.co <anon-key>
```

A ručne to jedno, čo automat nezvládne: **kúp si vstupenku vlastnou kartou** a
skontroluj, že príde e-mailom. Potom si ju refunduj v Stripe.

---

## Čo to celé stojí

| Položka | Mesačne |
| --- | --- |
| Doména blup.sk | ~1 € (platíš ročne) |
| Hosting Vercel | 0 € |
| Hosting Websupport | ~3 € (ak namiesto Vercelu) |
| Supabase | 0 € do 500 MB databázy, potom 25 € |
| Resend | 0 € do 3 000 e-mailov |
| Schránka vo Websupporte | ~1 € |
| Stripe | bez paušálu, 1,4 % + 0,25 € z platby |

**Reálne 2 – 4 € mesačne**, kým nezačneš rásť. Stripe platíš len z toho, čo
naozaj predáš.

---

## Keď niečo nefunguje

| Príznak | Príčina |
| --- | --- |
| `blup.sk` nejde | DNS sa ešte nepreplo — `dig +short blup.sk` a počkaj |
| Ide `www.blup.sk`, nie `blup.sk` | chýba A záznam pre `@` |
| `/event/<id>` vracia 404 | chýba `.htaccess` (FTP ho skryl) alebo `vercel.json` |
| Certifikát neplatí | vo Websupporte nie je zapnutý Let's Encrypt |
| E-maily nechodia | doména nie je vo Verified stave, alebo `EMAIL_FROM` je na inej doméne |
| E-maily padajú do spamu | dva SPF záznamy naraz — spoj ich do jedného |
| Po platbe zlé presmerovanie | `APP_PUBLIC_URL` nesedí alebo má lomku na konci |
