# Spustenie BLUPu na webe — krok za krokom

Od stiahnutého ZIPu po stránku, na ktorej si niekto kúpi vstupenku.

Počítaj s **2 – 3 hodinami** pri prvom raze, z toho väčšina je čakanie na
overenie domény a účtov. Nič z toho nevyžaduje Mac ani Apple developer účet —
web je celá aplikácia, nie doplnok k appke.

Príkazy sa spúšťajú z koreňa repozitára, ak nie je napísané inak.

---

## 0. Čo budeš potrebovať

| Vec | Na čo | Cena |
| --- | --- | --- |
| **Node.js 20+** | build a nástroje | zdarma |
| **Supabase** účet | databáza, prihlasovanie, úložisko, serverové funkcie | zdarma na štart |
| **Stripe** účet | platby za vstupenky a Premium | 1,4 % + 0,25 € z transakcie |
| **Resend** účet | odosielanie vstupeniek e-mailom | zdarma do 3 000 e-mailov/mesiac |
| **Doména** | `blup.sk` alebo čokoľvek iné | ~10 €/rok |
| **Hosting** | Vercel, Netlify alebo vlastný server | zdarma na štart |

Overenie Stripe účtu (identita, bankový účet) trvá typicky **1 – 2 dni**. Kým
prebehne, všetko sa dá skúšať v testovacom režime s testovacími kartami.

```bash
node --version     # musí byť v20 alebo vyššie
```

---

## 1. Príprava projektu

```bash
unzip blup-web.zip && cd blup
cd mobile && npm install && cd ..
```

Skopíruj si oba vzory premenných — vyplníš ich v ďalších krokoch:

```bash
cp mobile/.env.example mobile/.env      # verejné, ide to do prehliadača
cp supabase/.env.example supabase/.env  # tajné, ostáva na serveri
```

> **Rozdiel medzi nimi je zásadný.** Všetko v `mobile/.env` si vie prečítať
> ktokoľvek, kto otvorí stránku — patria tam len verejné identifikátory.
> Tajné kľúče idú výhradne do `supabase/.env` a nikdy sa nedostanú do
> prehliadača.

---

## 2. Supabase: databáza

1. Založ projekt na [supabase.com](https://supabase.com) — región **Frankfurt**
   alebo **Zürich**, ak cieliš na Slovensko.
2. Zapíš si heslo k databáze, ktoré ti ukáže pri zakladaní. Už ho neuvidíš.
3. Prepoj projekt a nahraj schému:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>   # z URL dashboardu
npx supabase db push
```

`db push` aplikuje **27 migrácií**: tabuľky, indexy, prístupové pravidlá,
platobné funkcie, účtovníctvo. Trvá to pár desiatok sekúnd.

Do `mobile/.env` doplň z **Project Settings → API**:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
```

### Zapni rozšírenia pre plánované úlohy

V **SQL Editore**:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

---

## 3. Over, že databáza naozaj sedí (voliteľné, ale odporúčam)

```bash
./scripts/verify-db.sh
```

Postaví dočasnú PostgreSQL databázu, aplikuje všetkých 27 migrácií od nuly a
prejde testovacím balíkom — **135 tvrdení**: či sa peniaze rátajú na cent, či
rezervácia drží vstupenky, či sa nikto nedostane k cudzím dátam a či platobné
funkcie nie sú volateľné z prehliadača.

Ak toto prejde, schéma je v poriadku a prípadný neskorší problém je v
konfigurácii, nie v databáze. To je pri hľadaní chyby veľmi užitočné vedieť.

---

## 4. Stripe: platby

### 4.1 Kľúče

**Developers → API keys**, zatiaľ v **Test mode**. Do `supabase/.env`:

```bash
STRIPE_SECRET_KEY=sk_test_...
```

`mobile/.env` nechaj bez Stripe kľúča — webová verzia žiadny nepotrebuje.
Adresu platobnej brány vydáva server.

### 4.2 Connect (výplaty organizátorom)

**Connect → Get started → Platform or marketplace.** Peniaze idú priamo na účet
organizátora a BLUP si z platby stiahne svoj podiel; nezdržiavajú sa u teba.

Do `supabase/.env`, s **tvojou** doménou:

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

### 4.4 Webhook

Toto je najdôležitejšie nastavenie v celom návode. **Vstupenka vzniká výhradne
z tejto správy** — nie z toho, že prehliadač povie „zaplatené“. Bez webhooku
peniaze odídu a vstupenka nepríde.

**Developers → Webhooks → Add endpoint**

- URL: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
- Udalosti (presne tieto):

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

Skopíruj **Signing secret** (`whsec_…`) do `supabase/.env`:

```bash
STRIPE_WEBHOOK_SECRET=whsec_...
```

Bez neho funkcia odmietne každý príchodzí požiadavok — čo je správne
predvolené správanie, nie chyba.

---

## 5. Resend: vstupenky e-mailom

1. Založ účet na [resend.com](https://resend.com).
2. **Domains → Add domain**, doplň DNS záznamy (SPF, DKIM). Overenie trvá
   minúty až hodiny.
3. **API Keys → Create**.

```bash
RESEND_API_KEY=re_...
EMAIL_FROM=Blup <vstupenky@blup.sk>
EMAIL_REPLY_TO=podpora@blup.sk
```

`EMAIL_FROM` **musí** byť na overenej doméne, inak Resend odmietne každé
odoslanie.

Bez kľúča appka nespadne: vstupenky sa vydajú a v aplikácii budú, len sa
neodošlú a fronta si ich označí ako preskočené.

---

## 6. Kľúče pre upozornenia v prehliadači

```bash
node scripts/generate-vapid-keys.mjs
```

Vypíše dvojicu. Verejnú polovicu do **oboch** súborov, súkromnú len na server:

```bash
# supabase/.env
VAPID_PUBLIC_KEY=B...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:podpora@blup.sk

# mobile/.env
EXPO_PUBLIC_VAPID_PUBLIC_KEY=B...
```

---

## 7. Adresa aplikácie

Do `supabase/.env` doplň skutočnú doménu, bez lomky na konci:

```bash
APP_PUBLIC_URL=https://blup.sk
```

Server prijme ako návrat z platby **len cesty na tejto adrese**. Preto zlá
hodnota platbu rozbije namiesto toho, aby ticho presmerovala inam — a to je
zámer: otvorené presmerovanie na stránke, ktorá práve zobrala peniaze, je
phishingová súprava.

Do `mobile/.env` tú istú doménu pre zdieľacie karty:

```bash
EXPO_PUBLIC_WEB_URL=https://blup.sk
```

---

## 8. Nahraj tajné kľúče a serverové funkcie

```bash
npx supabase secrets set --env-file supabase/.env
./scripts/deploy-functions.sh
```

Nasadí **16 funkcií**. Skript sám vie, ktoré musia bežať bez overenia tokenu
(Stripe ani cron nevedia poslať prihlasovací token — overujú sa podpisom alebo
servisným kľúčom).

Kontrola, že to všetko vidí:

```bash
curl https://<project-ref>.supabase.co/functions/v1/config-status
```

Vráti samé `true`/`false` — nikdy kľúč ani jeho časť. Čo je `false`, ešte
nefunguje.

---

## 9. Prihlasovanie

**Authentication → URL Configuration**:

- **Site URL:** `https://blup.sk`
- **Redirect URLs:** `https://blup.sk/auth/callback`,
  `https://blup.sk/auth/reset-password`

Ak chceš prihlásenie cez Google alebo Apple, zapni ich v **Providers**.
E-mailom to funguje hneď.

---

## 10. Plánované úlohy

V **SQL Editore**, s doplneným `<project-ref>` a servisným kľúčom:

```sql
-- vstupenky e-mailom (webhook ju aj tak hneď postrčí, toto je poistka)
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

-- týždenný prehľad, v pondelok ráno
select cron.schedule('blup-digest', '0 7 * * 1', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/weekly-digest',
    headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb);
$$);
```

`cart-sweep` je len upratovanie. Vypršaná rezervácia prestáva držať vstupenky
v tej sekunde, keď vyprší — nezáleží na tom, či medzitým niečo bežalo.

---

## 11. Build webu

```bash
cd mobile
npm run build:web
```

Jeden príkaz, ktorý spraví tri veci: zmaže cache, vyexportuje web a dopíše
konfiguráciu pre hosting.

Výsledok je priečinok **`mobile/dist`** — 75 obyčajných HTML súborov plus JS,
CSS a obrázky, dokopy asi 12 MB. Žiadny Node na serveri, žiadna databáza na
hostingu. Presne toto nahráš.

> **V ZIPe žiadne HTML nenájdeš, a je to správne.** HTML ešte neexistuje —
> vzniká až týmto príkazom, a vzniká s **tvojimi** údajmi zapečenými dovnútra
> (adresa tvojho Supabase projektu, tvoj verejný kľúč, tvoja doména). Build
> spravený niekým iným by ukazoval na cudziu databázu a nefungoval by.

Časť s konfiguráciou hostingu **nepreskakuj**. Dynamické adresy sú na disku
uložené ako `event/[id].html` aj so zátvorkami; bez presmerovania vráti hosting
na `/event/9f2c…` chybu 404. Skript to odvodí priamo z toho, čo build vyrobil,
a napíše `vercel.json`, `_redirects` aj `nginx.conf`.

Skontrolovať sa to dá lokálne:

```bash
npm run serve:web        # http://localhost:4321
```

Tento príkaz **nespúšťa** `npx serve`. Oba jeho režimy totiž klamú, každý inak:
`serve -s dist` prepíše každý požiadavok na `index.html`, takže dynamická
adresa vyzerá, že funguje, aj keď hosting na ňu nie je nastavený — a rozsype sa
až po nasadení. `serve dist` zas nepresmeruje nič, takže `/event/<id>` vráti
404, hoci na ostrom hostingu by fungovala.

`scripts/serve-web.mjs` číta ten istý `_redirects`, ktorý si práve vygeneroval,
a aplikuje ho v rovnakom poradí ako Netlify či Vercel: najprv skutočný súbor,
potom presmerovania, potom 404. Čo vidíš doma, to dostaneš aj vonku.

> **Po každej zmene `.env` zmaž cache**, inak sa do buildu dostanú staré
> hodnoty a stráviš hodinu hľadaním chyby, ktorá tam nie je:
> ```bash
> cd mobile && rm -rf .expo node_modules/.cache
> ```

### Nasadenie

**Vercel**

```bash
npm i -g vercel
cd mobile/dist && vercel --prod
```

**Netlify**

```bash
npm i -g netlify-cli
netlify deploy --prod --dir mobile/dist
```

**Vlastný server (nginx)** — nahraj obsah `mobile/dist` do webového koreňa a
vlož vygenerovaný `nginx.conf` do bloku `server { }`.

Nakoniec nasmeruj doménu na hosting a **skontroluj, že beží cez HTTPS**. Bez
neho nefunguje geolokácia, upozornenia ani service worker.

### Vlastná doména — čo prepísať

Povedzme, že máš `blup.space`. Na štyroch miestach musí byť tá istá adresa,
inak sa platba nevráti tam, kam má:

| Kde | Čo |
| --- | --- |
| `supabase/.env` | `APP_PUBLIC_URL=https://blup.space` |
| `supabase/.env` | `STRIPE_CONNECT_RETURN_URL` a `..._REFRESH_URL` na `https://blup.space/organizer/payouts` |
| `mobile/.env` | `EXPO_PUBLIC_WEB_URL=https://blup.space` |
| Supabase → Authentication | Site URL `https://blup.space`, redirect adresy `https://blup.space/auth/callback` a `/auth/reset-password` |

Po zmene `supabase/.env` znova `npx supabase secrets set --env-file supabase/.env`,
po zmene `mobile/.env` znova `npm run build:web`. Doména samotná sa nastavuje
v hostingu (Vercel: Settings → Domains) a u registrátora sa nasmerujú DNS
záznamy, ktoré ti hosting ukáže.

---

## 12. Prvý admin

Zaregistruj sa cez web normálne ako používateľ, potom v **SQL Editore**:

```sql
update public.profiles
set app_role = 'admin'
where id = (select id from auth.users where email = 'tvoj@email.sk');
```

Po obnovení stránky pribudne v bočnej navigácii **Admin**. Tam nastavíš sadzby,
reklamné kódy a uvidíš účtovníctvo platformy.

---

## 13. Prvý predaj: otestuj to celé

Skús presne toto poradie. Ak prejde, funguje ti celý reťazec.

1. **Otvor stránku v anonymnom okne.** Musíš vidieť eventy bez prihlásenia.
   Ak vidíš „Zatiaľ sa tu nič nedeje“, databáza je prázdna — to je správne,
   pokračuj bodom 2.
2. **Vytvor organizáciu** — Organizátor → Vytvoriť organizáciu.
3. **Over ju.** Platené vstupenky smie predávať len overená organizácia.
   V teste to zapneš ručne:
   ```sql
   update public.organizations set verification_status = 'verified';
   ```
4. **Vytvor event** s dátumom v budúcnosti a pridaj mu typ vstupenky s cenou.
5. **Prihlás sa ako niekto iný** (druhé anonymné okno), pridaj vstupenky do
   košíka. Sleduj, či beží odpočet.
6. **Zaplať testovacou kartou** `4242 4242 4242 4242`, ľubovoľný budúci dátum
   a CVC.
7. **Skontroluj, že vstupenka pribudla** v sekcii Vstupenky a prišla e-mailom.
8. **Skontroluj peniaze** v Organizátor → Účtovníctvo: predaj, provízia,
   archívny poplatok, čistý príjem. Súčet musí sedieť na cent.
9. **Naskenuj QR kód** cez Organizátor → Skener. Druhé načítanie toho istého
   kódu musí byť odmietnuté.

### Ďalšie testovacie karty

| Číslo | Čo simuluje |
| --- | --- |
| `4242 4242 4242 4242` | úspešná platba |
| `4000 0000 0000 9995` | nedostatok prostriedkov |
| `4000 0025 0000 3155` | vyžiada 3-D Secure |

---

## 14. Prepnutie na ostro

1. Dokonči overenie Stripe účtu (identita, banka).
2. V Stripe prepni na **Live mode** a vytvor si tam znova: kľúč, Premium ceny
   a **nový webhook** — testovací v ostrej prevádzke nefunguje.
3. Prepíš v `supabase/.env` hodnoty na `sk_live_…`, `whsec_…` a `price_…`.
4. `npx supabase secrets set --env-file supabase/.env`
5. Znova build a nasadenie (krok 11).
6. **Kúp si jednu vstupenku naozaj, vlastnou kartou.** Nič iné ti nepotvrdí,
   že to funguje. Potom si ju refunduj v Stripe a skontroluj, že sa v aplikácii
   označila ako vrátená.

### Pred spustením ešte

- V **Admin → Poplatky a sadzby** skontroluj províziu a archívny poplatok.
- V **Admin → Marketing** doplň Meta pixel a Google Ads, ak ich máš.
- Napíš obchodné podmienky a zásady ochrany údajov. Predávaš cudzie vstupenky
  — musí byť jasné, že zmluva je medzi kupujúcim a organizátorom a peniaze pri
  zrušení vracia organizátor. Vytlačené je to aj na samotnej vstupenke.

---

## 15. Keď niečo nefunguje

| Príznak | Príčina |
| --- | --- |
| `/event/<id>` vracia 404 | nespustil si `make-host-config.mjs`, alebo hosting nečíta `_redirects` |
| Platba prejde, vstupenka nepríde | webhook: zlá URL, chýbajúci `STRIPE_WEBHOOK_SECRET`, alebo nezaškrtnuté udalosti. Pozri **Developers → Webhooks → Attempts** |
| „Platby zatiaľ nie sú nakonfigurované“ | chýba `STRIPE_SECRET_KEY` v secrets; over cez `config-status` |
| Po platbe zlé presmerovanie | `APP_PUBLIC_URL` nesedí s doménou alebo má lomku na konci |
| E-mail nechodí | doména neoverená v Resend, alebo `EMAIL_FROM` je na inej doméne |
| Prázdna biela stránka | build má staré `.env` — zmaž `.expo` a `node_modules/.cache` a buildni znova |
| Geolokácia nefunguje | stránka nebeží cez HTTPS |
| „Na predaj vstupeniek potrebuješ overenie“ | organizácia nie je `verified` |
| Vstupenky sa v košíku samy strácajú | tak to má byť — rezervácia platí 15 minút |
| „Potvrdzovací e-mail sa nepodarilo odoslať" pri registrácii | Supabase nemá kam poslať potvrdenie. Na ostrom projekte to funguje samo; lokálne treba bežiaci `supabase start` aj so schránkou (inbucket), alebo v **Authentication → Providers → Email** dočasne vypnúť potvrdzovanie |

---

## 16. Otestuj nasadenie automaticky

Dva skripty, ktoré sa dajú pustiť proti čomukoľvek — lokálnemu buildu aj
ostrému webu.

```bash
# funkčný test: hosť, registrácia, uloženie, košík, organizátor, admin
node scripts/smoke-web.mjs https://blup.space

# bezpečnostné sondy: čo sa NESMIE dať s kľúčom z prehliadača
./scripts/probe-security.sh https://<project-ref>.supabase.co <anon-key>
```

Prvý prejde 22 krokov v skutočnom prehliadači a skontroluje aj to, či rozpis v
účtovníctve sedí na cent. Druhý sa prihlási ako bežný používateľ a skúsi si
vydať vstupenku bez platby, prečítať cudzí QR kód, dať si Premium zadarmo a
povýšiť sa na admina — a overí, že **nič z toho nejde**, ale že hosť si stále
vie prezerať eventy.

Oba vracajú nenulový kód pri zlyhaní, takže sa dajú zapojiť do CI.

---

Máš vlastnú doménu? Celý postup pre DNS, hosting a e-mail je v
**[DOMENA.md](DOMENA.md)** — písaný pre doménu vedenú vo Websupporte.

Podrobnosti k jednotlivým oblastiam: **PAYMENTS.md** (peniaze),
**WEB.md** (webová verzia), **DATABASE.md** (schéma), **API.md** (funkcie),
**ENVIRONMENT.md** (premenné).
