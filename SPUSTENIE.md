# BLUP na blup.sk — od nuly po predanú vstupenku

Jeden návod, dvanásť fáz. Po každej je **kontrola** — konkrétny príkaz alebo
vec, ktorú musíš vidieť. Ak kontrola neprejde, nepokračuj: chyba sa o tri kroky
neskôr hľadá desaťkrát ťažšie.

Počítaj s **3 – 4 hodinami čistého času**, rozloženými do dvoch–troch dní. Väčšina
čakania je na cudzie strany: overenie Stripe účtu (1 – 2 dni) a rozšírenie DNS
(minúty až hodiny).

Nepotrebuješ Mac, Apple developer účet ani server. Web je celá aplikácia.

> Príkazy spúšťaj z koreňa rozbaleného projektu, ak nie je napísané inak.

---

## Čo budeš potrebovať

| Vec | Načo | Cena |
| --- | --- | --- |
| **Node.js 20+** | build | zdarma |
| **Supabase** | databáza, prihlasovanie, serverové funkcie | 0 € do 500 MB |
| **Stripe** | platby | 1,4 % + 0,25 € z platby |
| **Resend** | odosielanie vstupeniek | 0 € do 3 000 e-mailov |
| **blup.sk** | máš vo Websupporte | ~1 €/mesiac |
| **Vercel** alebo Websupport hosting | kam sa nahrá web | 0 € / ~3 € |

Reálne to vyjde na **2 – 4 € mesačne**, kým nezačneš rásť.

---

## Fáza 0 · Príprava (10 minút)

```bash
node --version          # musí byť v20 alebo vyššie
unzip blup-final.zip && cd blup
cd mobile && npm install && cd ..
cp mobile/.env.example mobile/.env
cp supabase/.env.example supabase/.env
```

Dva súbory s premennými, a rozdiel medzi nimi je zásadný:

- `mobile/.env` → **verejné.** Všetko odtiaľ skončí v prehliadači a vie si to
  prečítať ktokoľvek. Patria sem len identifikátory.
- `supabase/.env` → **tajné.** Nikdy neopustí server.

**✓ Kontrola:** `ls -la mobile/.env supabase/.env` — oba existujú.

---

## Fáza 1 · Databáza (20 minút)

1. Založ projekt na [supabase.com](https://supabase.com). Región **Frankfurt**
   alebo **Zürich**.
2. **Heslo k databáze si hneď ulož** — druhýkrát ti ho neukáže.
3. Nahraj schému:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>    # z URL dashboardu
npx supabase db push
```

Aplikuje sa 29 migrácií: tabuľky, prístupové pravidlá, platobné funkcie,
účtovníctvo. Trvá to pol minúty.

4. V **SQL Editore** zapni rozšírenia pre plánované úlohy:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

5. Z **Project Settings → API** prepíš do `mobile/.env`:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
```

**✓ Kontrola:**

```bash
./scripts/verify-db.sh
```

Postaví dočasnú databázu, aplikuje všetkých 29 migrácií od nuly a prejde
**135 tvrdení** — či peniaze sedia na cent, či rezervácia drží vstupenky, či sa
nikto nedostane k cudzím dátam. Musí skončiť `✅ Database verified`.

Ak toto prejde, schéma je v poriadku a každý neskorší problém je v konfigurácii.
To je pri hľadaní chyby veľmi cenné vedieť.

---

## Fáza 2 · Doména a DNS (15 minút + čakanie)

### Najprv sa rozhodni, kde bude hosting

**Vercel** — odporúčam. Nasadenie jedným príkazom, HTTPS certifikát si vypýta a
obnovuje sám, každé nasadenie má vlastnú adresu na náhľad pred spustením. Zdarma.

**Websupport** — dá sa, a je otestované. Beží na Apache; `.htaccess`, ktorý ti
build vygeneruje, bol vyskúšaný na skutočnom Apachi vrátane dynamických adries.
Výhoda: všetko na jednom mieste. Nevýhoda: nasadzuješ ručne cez FTP a nemáš
náhľad.

**Nekupuj kvôli tomu VPS.** Nie je čo spravovať — je to priečinok so súbormi.

### DNS vo Websupporte

[admin.websupport.sk](https://admin.websupport.sk) → **Domény → blup.sk → DNS záznamy**.

Ako to funguje, nech vieš, čo robíš:

| Typ | Na čo |
| --- | --- |
| **A** / **CNAME** | kam ide prehliadač, keď napíše blup.sk |
| **MX** | kam chodí pošta, ktorú ti **niekto pošle** |
| **TXT** (SPF, DKIM) | kto smie **odosielať** poštu v mene blup.sk |

Tri nezávislé veci. Web môže byť na Verceli, schránka vo Websupporte a vstupenky
môže rozposielať Resend — naraz a bez konfliktu.

**Pre Vercel** pridaj (presné hodnoty ti ukáže Vercel v *Settings → Domains*,
použi tie — občas ich menia):

| Typ | Názov | Hodnota |
| --- | --- | --- |
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

**Pre Websupport hosting** sa A záznam nastaví sám pri založení hostingu.

**✓ Kontrola:**

```bash
dig +short blup.sk
dig +short www.blup.sk
```

Musí vrátiť IP adresu. Kým nevráti, nemá zmysel riešiť nič ďalšie.

---

## Fáza 3 · Prvý build a nasadenie (20 minút)

```bash
cd mobile
npm run build:web
```

Jeden príkaz spraví tri veci: zmaže cache, vyexportuje web a dopíše konfiguráciu
pre hosting. Vznikne priečinok **`mobile/dist`** — 77 obyčajných HTML súborov
plus JS a CSS, dokopy asi 12 MB.

Do konfigurácie sa zapíšu aj pravidlá pre náhľady odkazov. Tie potrebujú adresu
tvojho Supabase projektu, takže **`mobile/.env` musí byť vyplnený už teraz** —
build ťa upozorní, ak nie je, a náhľady budú generické, kým to nespravíš.

> **V projekte žiadne HTML nenájdeš, a je to správne.** Vzniká až teraz a vzniká
> s **tvojimi** údajmi zapečenými dovnútra — adresa tvojho Supabase projektu,
> tvoj verejný kľúč. Build od niekoho iného by ukazoval na cudziu databázu.

### Nasadenie na Vercel

```bash
npm i -g vercel
cd dist && vercel --prod
```

Pri prvom spustení sa opýta na projekt. Potom pridaj doménu vo
**Settings → Domains → blup.sk**.

### Nasadenie na Websupport

Obsah `mobile/dist` nahraj cez FTP (údaje v administrácii pod
**Hosting → FTP prístupy**) do priečinka `web/`. Nahrávaj **obsah**, nie
priečinok — v `web/` má priamo ležať `index.html`.

**Nezabudni na `.htaccess`.** Je v `dist`, ale FTP klienti súbory začínajúce
bodkou skrývajú. V FileZille: *Server → Vynútiť zobrazenie skrytých súborov*.
Bez neho vráti `/event/<id>` chybu 404.

V administrácii zapni **Let's Encrypt** a presmerovanie na HTTPS.

**✓ Kontrola:** otvor `https://blup.sk` — musíš vidieť eventy (alebo prázdny
stav, ak je databáza čistá) a v adresnom riadku zámok. Potom skús adresu
`https://blup.sk/nonsense` — musí prísť stránka „nenašlo sa", nie chyba servera.

---

## Fáza 4 · Stripe (30 minút + 1–2 dni na overenie)

Zatiaľ všetko v **Test mode**, prepínač je vpravo hore.

### 4.1 Kľúč

**Developers → API keys** → do `supabase/.env`:

```bash
STRIPE_SECRET_KEY=sk_test_...
```

Do `mobile/.env` Stripe kľúč **nepatrí** — webová verzia žiadny nepotrebuje,
adresu platobnej brány vydáva server.

### 4.2 Connect — výplaty organizátorom

**Connect → Get started → Platform or marketplace.** Peniaze idú priamo na účet
organizátora, BLUP si z platby stiahne svoj podiel. Nezdržiavajú sa u teba.

```bash
STRIPE_CONNECT_RETURN_URL=https://blup.sk/organizer/payouts
STRIPE_CONNECT_REFRESH_URL=https://blup.sk/organizer/payouts
```

### 4.3 Ceny pre Premium

**Products → Add product**, dve opakované ceny — mesačná a ročná:

```bash
STRIPE_PRICE_PREMIUM_MONTHLY=price_...
STRIPE_PRICE_PREMIUM_YEARLY=price_...
```

### 4.4 Webhook — najdôležitejšie nastavenie v celom návode

**Vstupenka vzniká výhradne z tejto správy.** Nie z toho, že prehliadač povie
„zaplatené". Bez webhooku peniaze odídu a vstupenka nepríde.

**Developers → Webhooks → Add endpoint**

- URL: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
- Udalosti — presne týchto jedenásť:

```
payment_intent.succeeded
payment_intent.payment_failed
payment_intent.canceled
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
charge.refunded
account.updated
transfer.created
transfer.paid
```

Skopíruj **Signing secret**:

```bash
STRIPE_WEBHOOK_SECRET=whsec_...
```

Bez neho funkcia odmietne každý príchodzí požiadavok. To je správne predvolené
správanie, nie chyba.

**✓ Kontrola:** v `supabase/.env` máš vyplnené štyri riadky —
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` a dve `price_`.

---

## Fáza 5 · E-mail (20 minút + čakanie na DNS)

Sú to **dve rôzne veci** a toto sa mýli najčastejšie.

### 5a. Schránka, do ktorej ti ľudia píšu

`ahoj@blup.sk`. Websupport → **Hosting → E-mail → Pridať schránku.** MX záznamy
si nastaví sám. Pár eur mesačne.

Alternatívy: **Google Workspace** (~6 €/používateľ, kalendár a disk navyše)
alebo **Zoho Mail** (zdarma pre jedného používateľa). Vtedy MX prepíšeš na tie ich.

### 5b. Odosielanie vstupeniek

Cez obyčajný SMTP by tisíce vstupeniek skončili v spame a poskytovateľ by ti to
zastavil. Na to je [Resend](https://resend.com).

1. Účet → **Domains → Add domain → `blup.sk`**
2. Ukáže ti tri až štyri záznamy. Pridaj ich vo Websupporte presne tak, ako ich
   vypíše:

| Typ | Názov | Hodnota |
| --- | --- | --- |
| TXT | `resend._domainkey` | `p=MIGfMA0…` (dlhý reťazec) |
| TXT | `@` alebo `send` | `v=spf1 include:amazonses.com ~all` |
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com`, priorita 10 |

3. Počkaj na zelené **Verified**.
4. **API Keys → Create** → do `supabase/.env`:

```bash
RESEND_API_KEY=re_...
EMAIL_FROM=Blup <vstupenky@blup.sk>
EMAIL_REPLY_TO=ahoj@blup.sk
```

> **Pasca: SPF smie byť pre doménu len jeden.**
> Ak už máš `v=spf1 include:websupport.sk ~all` a Resend chce svoj,
> **nepridávaj druhý riadok** — spoj ich:
> ```
> v=spf1 include:websupport.sk include:amazonses.com ~all
> ```
> Dva samostatné SPF záznamy sú horšie než žiadny: overenie zlyhá na oboch.
> Ak ti Resend ponúkne subdoménu `send.blup.sk`, vezmi ju — má vlastný SPF a
> problém úplne obíde.

`EMAIL_FROM` **musí** byť na overenej doméne, inak Resend odmietne každé
odoslanie.

**✓ Kontrola:** v Resende svieti pri `blup.sk` zelené **Verified**.

### 5c. Potvrdzovacie e-maily pri registrácii

**Toto je tretia, samostatná vec — a bez nej ti registrácia nedobehne.**

Supabase má vlastnú odosielaciu službu, ale tá je len na skúšanie: pošle
**dva e-maily za hodinu** a na nových projektoch **iba na adresy členov tímu**.
Registrácia teda zvonku vyzerá, že prešla, a potvrdenie nikdy nepríde.

Nasmeruj Supabase na Resend, ktorý si už nastavil v 5b:

**Authentication → Emails → SMTP Settings** → zapni **Enable Custom SMTP**:

| Pole | Hodnota |
| --- | --- |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` (doslova, nie tvoj e-mail) |
| Password | ten istý `re_...` kľúč ako v `RESEND_API_KEY` |
| Sender email | `vstupenky@blup.sk` (musí byť na overenej doméne) |
| Sender name | `Blup` |

Potom **Authentication → Rate Limits** → *Emails per hour* zdvihni z `2`
napríklad na `100`. Kým tam sedí dvojka, tretia registrácia v hodine ticho odpadne.

**✓ Kontrola:** zaregistruj sa na adresu, ktorá **nie je** tvoj Supabase účet.
Do minúty musí prísť potvrdzovací e-mail. V **Authentication → Logs** vidíš pri
každom pokuse, či odoslanie prešlo alebo prečo nie.

> Kým toto nemáš hotové, vieš sa cez registráciu prehrýzť tak, že v
> **Authentication → Providers → Email** vypneš **Confirm email**. Aplikácia s
> tým počíta a pustí ťa rovno do aplikácie. **Pred Fázou 11 to zapni späť** —
> bez potvrdenia ti ktokoľvek založí účet na cudziu adresu.

---

## Fáza 6 · Upozornenia v prehliadači (5 minút)

```bash
node scripts/generate-vapid-keys.mjs
```

Verejnú polovicu do **oboch** súborov, súkromnú len na server:

```bash
# supabase/.env
VAPID_PUBLIC_KEY=B...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:ahoj@blup.sk

# mobile/.env
EXPO_PUBLIC_VAPID_PUBLIC_KEY=B...
```

---

## Fáza 7 · Adresa aplikácie a nasadenie servera (15 minút)

Doména musí byť na **štyroch miestach**. Keď trafíš tri zo štyroch, platba sa
vráti niekam inam než na tvoju stránku.

```bash
# supabase/.env
APP_PUBLIC_URL=https://blup.sk
STRIPE_CONNECT_RETURN_URL=https://blup.sk/organizer/payouts
STRIPE_CONNECT_REFRESH_URL=https://blup.sk/organizer/payouts

# mobile/.env
EXPO_PUBLIC_WEB_URL=https://blup.sk
```

Bez lomky na konci. Server prijme ako návrat z platby **len cesty na tejto
adrese** — zlá hodnota preto platbu rozbije namiesto toho, aby ticho
presmerovala inam. Otvorené presmerovanie na stránke, ktorá práve zobrala
peniaze, je phishingová súprava.

Nahraj tajné kľúče a serverové funkcie:

```bash
npx supabase secrets set --env-file supabase/.env
./scripts/deploy-functions.sh
```

Nasadí 16 funkcií. Skript vie, ktoré musia bežať bez overenia tokenu — Stripe
ani cron nevedia poslať prihlasovací token, overujú sa podpisom alebo servisným
kľúčom.

**✓ Kontrola:**

```bash
curl https://<project-ref>.supabase.co/functions/v1/config-status
```

Vráti samé `true`/`false` — nikdy kľúč ani jeho časť. Musíš vidieť `true` pri
`stripe`, `stripeWebhook`, `email` a `webPush`. Čo je `false`, to ešte nefunguje.

---

## Fáza 8 · Prihlasovanie a plánované úlohy (10 minút)

Supabase → **Authentication → URL Configuration**:

- **Site URL:** `https://blup.sk`
- **Redirect URLs:** `https://blup.sk/auth/callback`,
  `https://blup.sk/auth/reset-password`

Ak chceš prihlásenie cez Google alebo Apple, zapni ich v **Providers**.
E-mailom funguje hneď.

V **SQL Editore** (doplň `<project-ref>` a servisný kľúč):

```sql
-- vstupenky e-mailom (webhook ju hneď postrčí, toto je poistka)
select cron.schedule('blup-tickets', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/ticket-email',
    headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb,
    body := '{"limit": 25}'::jsonb);
$$);

-- upratanie vypršaných rezervácií v košíku
select cron.schedule('blup-cart', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/cart-sweep',
    headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb);
$$);

-- upozornenia
select cron.schedule('blup-push', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/push-dispatch',
    headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb);
$$);

-- týždenný prehľad, pondelok ráno
select cron.schedule('blup-digest', '0 7 * * 1', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/weekly-digest',
    headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb);
$$);
```

`cart-sweep` je len upratovanie — vypršaná rezervácia prestáva držať vstupenky
v tej sekunde, keď vyprší, nech beží čokoľvek.

**✓ Kontrola:** `select jobname, schedule from cron.job;` — štyri riadky.

---

## Fáza 9 · Prvý admin a organizácia (10 minút)

1. Znova zbuilduj a nasaď (menil si `mobile/.env`):

```bash
cd mobile && npm run build:web && cd dist && vercel --prod
```

2. Zaregistruj sa na `blup.sk` normálne ako používateľ.
3. V **SQL Editore**:

```sql
update public.profiles
set app_role = 'admin'
where id = (select id from auth.users where email = 'tvoj@email.sk');
```

4. Obnov stránku — v bočnej navigácii pribudne **Admin**.
5. **Organizátor → Vytvoriť organizáciu**, potom **Overenie** a vyplň právne
   údaje. V testovacej fáze si ju over ručne:

```sql
update public.organizations set verification_status = 'verified';
```

Platené vstupenky smie predávať len overená organizácia.

**✓ Kontrola:** v bočnej navigácii vidíš **Admin** aj **Organizátor**.

---

## Fáza 10 · Testovací predaj (20 minút)

Toto je tá fáza, ktorá rozhodne, či to naozaj funguje. Choď presne v tomto poradí.

1. **Anonymné okno** → `blup.sk`. Musíš vidieť eventy **bez prihlásenia**.
2. **Vytvor event** s dátumom v budúcnosti.
3. **Pridaj mu typ vstupenky** s cenou (Organizátor → Vstupenky).
4. **Druhé anonymné okno**, iný účet → pridaj vstupenky do košíka. Sleduj, či
   beží odpočet 15 minút.
5. **Zaplať** testovacou kartou `4242 4242 4242 4242`, ľubovoľný budúci dátum,
   ľubovoľné CVC.
6. **Vstupenka musí pribudnúť** v sekcii Vstupenky **a prísť e-mailom**.
7. **Účtovníctvo** (Organizátor → Účtovníctvo): predaj, provízia, archívny
   poplatok, čistý príjem. Súčet musí sedieť na cent.
8. **Naskenuj QR** cez Organizátor → Skener. **Druhé načítanie toho istého kódu
   musí byť odmietnuté.**

| Karta | Čo simuluje |
| --- | --- |
| `4242 4242 4242 4242` | úspešná platba |
| `4000 0000 0000 9995` | nedostatok prostriedkov |
| `4000 0025 0000 3155` | vyžiada 3-D Secure |

**✓ Kontrola:** prešli všetky body 1 – 8. Ak nie bod 6, choď rovno na webhook
(Fáza 4.4) — v Stripe **Developers → Webhooks → Attempts** uvidíš, čo sa stalo.

---

## Fáza 11 · Prepnutie naostro (20 minút)

1. Dokonči overenie Stripe účtu — identita a bankový účet.
2. V Stripe prepni na **Live mode** a vytvor si tam **znova**: kľúč, Premium
   ceny a **nový webhook**. Testovací v ostrej prevádzke nefunguje.
3. Prepíš v `supabase/.env` na `sk_live_…`, `whsec_…`, `price_…`.
4. `npx supabase secrets set --env-file supabase/.env`
5. Znova build a nasadenie.
6. **Kúp si jednu vstupenku naozaj, vlastnou kartou.** Nič iné ti nepotvrdí, že
   to funguje. Potom si ju v Stripe refunduj a skontroluj, že sa v aplikácii
   označila ako vrátená.

Pred spustením ešte:

- **Admin → Poplatky a sadzby** — skontroluj províziu a archívny poplatok.
- **Admin → Marketing** — doplň Meta pixel a Google Ads, ak ich máš.
- **Obchodné podmienky a ochrana údajov.** Predávaš cudzie vstupenky, takže musí
  byť jasné, že zmluva je medzi kupujúcim a organizátorom a peniaze pri zrušení
  vracia organizátor. Vytlačené je to aj na samotnej vstupenke.

---

## Fáza 12 · Automatické testy

Dva skripty, ktoré vieš pustiť kedykoľvek — aj po každej ďalšej zmene.

```bash
# 22 krokov v skutočnom prehliadači
node scripts/smoke-web.mjs https://blup.sk

# 19 bezpečnostných sond
./scripts/probe-security.sh https://<project-ref>.supabase.co <anon-key>
```

Prvý prejde hosťa, registráciu, uloženie eventu, košík, organizátora aj admina —
a skontroluje, či rozpis v účtovníctve sedí na cent.

Druhý sa prihlási ako bežný používateľ a skúsi si vydať vstupenku bez platby,
prečítať cudzí QR kód, dať si Premium zadarmo a povýšiť sa na admina. Overí, že
**nič z toho nejde** — a zároveň, že hosť si stále vie prezerať eventy.

Oba vracajú nenulový kód pri zlyhaní, takže sa dajú zapojiť do CI.

**✓ Kontrola:** `22 prešlo, 0 zlyhalo` a `19 prešlo, 0 zlyhalo`.

---

## Keď niečo nefunguje

| Príznak | Príčina |
| --- | --- |
| `blup.sk` nejde | DNS sa ešte nepreplo — `dig +short blup.sk` a počkaj |
| Ide `www.blup.sk`, nie `blup.sk` | chýba A záznam pre `@` |
| `/event/<id>` vracia 404 | chýba `.htaccess` (FTP ho skryl) alebo `vercel.json` |
| Certifikát neplatí | vo Websupporte nie je zapnutý Let's Encrypt |
| Platba prejde, vstupenka nepríde | webhook: zlá URL, chýbajúci secret alebo nezaškrtnuté udalosti — pozri **Developers → Webhooks → Attempts** |
| „Platby zatiaľ nie sú nakonfigurované" | chýba `STRIPE_SECRET_KEY`; over cez `config-status` |
| Po platbe zlé presmerovanie | `APP_PUBLIC_URL` nesedí s doménou alebo má lomku na konci |
| E-maily nechodia | doména nie je vo Verified, alebo `EMAIL_FROM` je na inej doméne |
| E-maily padajú do spamu | dva SPF záznamy naraz — spoj ich do jedného |
| Potvrdzovací e-mail po registrácii nechodí | Supabase posiela cez vlastnú službu len 2/hodinu a len členom tímu — nastav SMTP na Resend, **Fáza 5c** |
| Potvrdenie prišlo raz a potom už nie | narazil si na *Emails per hour* — zdvihni limit v **Authentication → Rate Limits** |
| Odkaz v potvrdení hlási neplatnú adresu | `Redirect URLs` v **Fáze 8** nesedia s doménou |
| Prázdna biela stránka | build má staré `.env` — `rm -rf mobile/.expo mobile/node_modules/.cache` a znova |
| Geolokácia nefunguje | stránka nebeží cez HTTPS |
| „Na predaj vstupeniek potrebuješ overenie" | organizácia nie je `verified` |
| Vstupenky sa v košíku samy strácajú | tak to má byť — rezervácia platí 15 minút |

---

## Čo to stojí mesačne

| Položka | Koľko |
| --- | --- |
| Doména blup.sk | ~1 € (platíš ročne) |
| Hosting Vercel | 0 € |
| Hosting Websupport (namiesto Vercelu) | ~3 € |
| Supabase | 0 € do 500 MB, potom 25 € |
| Resend | 0 € do 3 000 e-mailov |
| Schránka | ~1 € |
| Stripe | bez paušálu, 1,4 % + 0,25 € z platby |

**Reálne 2 – 4 € mesačne.** Stripe platíš len z toho, čo naozaj predáš.

---

Podrobnosti k jednotlivým oblastiam: **PAYMENTS.md** (peniaze), **WEB.md**
(webová verzia), **DATABASE.md** (schéma), **API.md** (funkcie),
**ENVIRONMENT.md** (premenné).
