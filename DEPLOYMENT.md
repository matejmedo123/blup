# CREW. — návod na nasadenie

Od prázdneho servera po fungujúci systém. Postup je rovnaký pre Vercel, VPS aj
Docker; líši sa len krok 5.

---

## 0. Čo potrebuješ

| Vec | Verzia / poznámka |
|---|---|
| Node.js | **≥ 20.9** (Next 16 nižšie nenaštartuje). Odporúčam 22 LTS |
| PostgreSQL | **≥ 14**. Spravovaný (Neon, Supabase, RDS) alebo vlastný |
| Doména s HTTPS | Bez TLS sa **nikto neprihlási** — vysvetlenie v kroku 6 |
| SMTP / Resend účet | Nepovinné, ale bez neho nechodia e-maily |

> **Dôležité obmedzenie:** rate limiter a realtime zbernica bežia **v pamäti
> procesu** (`src/lib/rate-limit.ts`, `src/lib/realtime.ts`). Nasadenie je preto
> navrhnuté na **jednu inštanciu**. Podrobnosti a riešenie v kroku 9.

---

## 1. Zdrojový kód

```bash
git clone https://github.com/matejmedo123/blup.git crew
cd crew
git checkout claude/crew-event-management-system-71cmh9
npm ci
```

`npm ci` (nie `npm install`) — inštaluje presne to, čo je v `package-lock.json`.

---

## 2. Databáza

Vytvor prázdnu databázu a používateľa, ktorý do nej smie zapisovať:

```sql
CREATE DATABASE crew;
CREATE USER crew_app WITH PASSWORD 'dlhé-náhodné-heslo';
GRANT ALL PRIVILEGES ON DATABASE crew TO crew_app;
```

Pri spravovanej DB (Neon, Supabase) toto spraví panel a dostaneš hotový
connection string.

**Aplikácia nepotrebuje superusera.** Migrácie vytvárajú len tabuľky, indexy
a CHECK constrainty — žiadne rozšírenia.

---

## 3. Premenné prostredia

```bash
cp .env.example .env.local   # VPS/Docker
```

Na Verceli ich vlož cez **Settings → Environment Variables**, nie súborom.

Minimum, bez ktorého to nemá zmysel nasadzovať:

| Premenná | Prečo je povinná |
|---|---|
| `DATABASE_URL` | Bez `postgres://` prefixu appka **ticho spadne na PGlite** a dáta ti zmiznú pri reštarte |
| `APP_URL` | Odkazy v e-mailoch a QR kódoch inak vedú na `localhost:3000` |
| `CRON_SECRET` | Bez neho `/api/cron/reminders` vracia **503** a nechodia žiadne pripomienky |

Tajomstvá generuj poriadne:

```bash
openssl rand -hex 32     # CRON_SECRET
```

Session tokeny ani QR podpisy **nepotrebujú globálne tajomstvo** — sessiony sú
náhodné opaque tokeny uložené v DB ako SHA-256, QR sa podpisuje tajomstvom
konkrétnej smeny (`shifts.qr_secret`). Nie je čo rotovať.

---

## 4. Migrácie

```bash
DATABASE_URL='postgres://…' npm run db:migrate
```

Vypíše `✓ migrácie aplikované na PostgreSQL`. Je to idempotentné — opakované
spustenie nič nepokazí.

V produkcii nastav aj `CREW_SKIP_AUTO_MIGRATE=true`, aby migrácie nebežali pri
každom štarte procesu, ale len týmto krokom v deploy pipeline.

---

## 5. Build a štart

### 5a. Vercel (najmenej práce)

1. Naimportuj repozitár, branch `claude/crew-event-management-system-71cmh9`
2. Framework sa deteguje sám (Next.js), build command nechaj default
3. Vlož premenné z kroku 3
4. Migrácie: `npm run db:migrate` ako **Build Command prefix**, alebo raz ručne
5. Deploy

> Vercel škáluje na viac lambd — prečítaj si krok 9, týka sa ťa to.

### 5b. VPS (systemd)

```bash
npm run build
```

`/etc/systemd/system/crew.service`:

```ini
[Unit]
Description=CREW.
After=network.target postgresql.service

[Service]
Type=simple
User=crew
WorkingDirectory=/opt/crew
EnvironmentFile=/opt/crew/.env.local
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now crew
sudo systemctl status crew
```

Pred `crew` postav nginx alebo Caddy s TLS (krok 6).

### 5c. Docker

`Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "run", "start"]
```

```bash
docker build -t crew .
docker run -d --name crew -p 3000:3000 --env-file .env.local crew
```

Obraz je väčší, než býva zvykom — `next.config.ts` drží `pg` a `@electric-sql/pglite`
mimo bundlu (`serverExternalPackages`), lebo načítavajú natívne a WASM prostriedky
za behu. Ak chceš menší obraz, prepni na `output: "standalone"` a skopíruj len
`.next/standalone` — ale over, že sa `pg` do obrazu dostal.

---

## 6. HTTPS nie je voliteľné

Session cookie sa nastavuje s `secure: true`, keď `NODE_ENV === "production"`
(`src/lib/auth/session.ts:62`). Prehliadač takú cookie **cez čisté HTTP zahodí**,
takže prihlásenie zlyhá bez akejkoľvek chybovej hlášky — používateľa to len
odrazí späť na prihlasovaciu stránku.

Ochrana proti CSRF navyše porovnáva hlavičku `Origin` s `Host`. Reverse proxy
musí posielať skutočné hlavičky:

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";
    proxy_buffering    off;          # nutné pre SSE (/api/realtime)
    proxy_read_timeout 1h;
}
```

`proxy_buffering off` nevynechávaj — bez neho sa živá dochádzka a chat
zaseknú, lebo nginx si SSE stream odloží do bufferu.

---

## 7. Prvý admin

```bash
SEED_ADMIN_EMAIL=admin@tvojadomena.sk \
SEED_ADMIN_PASSWORD='dlhé-náhodné-heslo' \
DATABASE_URL='postgres://…' \
npm run db:seed
```

Seed v produkcii **zámerne spadne**, ak `SEED_ADMIN_PASSWORD` nenastavíš —
aby sa do nasadeného systému nikdy nedostalo heslo z kódu.

Seed napĺňa aj demo event (Grape Festival 2026, 10 pozícií, 15 smien, 10 crew).
Ak chceš čisto prázdny systém, vytvor admina ručne a demo dáta preskoč — alebo
event po prihlásení zmaž cez **Nastavenia**.

Po prvom prihlásení heslo zmeň a `SEED_*` premenné z prostredia odstráň.

---

## 8. Cron na pripomienky

Endpoint `/api/cron/reminders` rieši 24 h potvrdenia smien, pripomienky
check-inu a check-outu a označovanie no-show. **Bez neho systém funguje, ale
nikomu nič nepripomenie.**

Spúšťaj **každú hodinu**. Je idempotentný — dvojité spustenie neposiela nič
druhýkrát.

Vercel (`vercel.json`):

```json
{ "crons": [{ "path": "/api/cron/reminders", "schedule": "0 * * * *" }] }
```

VPS (crontab):

```cron
0 * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://crew.tvojadomena.sk/api/cron/reminders
```

Overenie, že žije:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://crew.tvojadomena.sk/api/cron/reminders
```

`503` znamená, že `CRON_SECRET` nie je nastavené. `401` znamená, že posielaš iné.

---

## 9. Škálovanie — prečítaj pred pridaním druhej inštancie

Dve veci držia stav **v pamäti procesu**:

| Modul | Čo sa pokazí na viacerých inštanciách |
|---|---|
| `src/lib/rate-limit.ts` | Limit 8 pokusov o prihlásenie platí *na inštanciu*. Pri 4 inštanciách má útočník reálne 32 pokusov |
| `src/lib/realtime.ts` | SSE dostane len ten, kto sedí na tej istej inštancii ako odosielateľ. Chat a živá dochádzka budú vynechávať |

Obe sú **zámerne za rozhraním** (`RateLimiter`, `RealtimeBus`), takže výmena je
lokálna — nová trieda a jeden riadok vo factory, volajúci kód sa nemení:

- **Rate limit → Redis:** `INCR` + `EXPIRE` na kľúč okna
- **Realtime → Redis pub/sub** alebo **Postgres `LISTEN`/`NOTIFY`** (nemusíš
  pridávať ďalšiu službu)

Kým to nespravíš, drž **jednu inštanciu** a škáluj vertikálne. Na jeden festival
to bohato stačí — úzke hrdlo je databáza, nie appka.

Pri `DATABASE_POOL_MAX` počítaj `inštancie × pool ≤ max_connections` databázy.

---

## 10. Kontrola po nasadení

```bash
curl -sI https://crew.tvojadomena.sk | head -1          # 200
curl -s  https://crew.tvojadomena.sk/admin -o /dev/null -w '%{http_code}\n'   # 307 na prihlásenie
```

Potom ručne:

- [ ] Prihlásenie adminom funguje a **cookie prežije reload** (ak nie → HTTPS, krok 6)
- [ ] `/admin` ukazuje dashboard s dátami
- [ ] Vytvorenie smeny a pridelenie človeka prejde
- [ ] `/portal` na **telefóne** — spodná navigácia, check-in tlačidlo
- [ ] Export `/api/exports/payroll.csv` stiahne súbor s hlavičkou
- [ ] Cron endpoint vráti `200` (krok 8)
- [ ] Skús sa dostať na `/admin` účtom bežného crew → musí ťa odmietnuť

---

## 11. Zálohy a GDPR

**Zálohuj databázu.** Všetko okrem statických súborov žije v Postgrese:

```cron
30 3 * * * pg_dump "$DATABASE_URL" | gzip > /var/backups/crew-$(date +\%F).sql.gz
```

Zálohy obsahujú osobné údaje (mená, telefóny, IBAN-y). Šifruj ich a drž
retenciu, ktorú máš v zásadách — nie „navždy".

Systém pokrýva export aj mazanie údajov osoby cez admin rozhranie; audit log
zaznamenáva, kto k čomu pristupoval. Za nastavenie retenčnej doby a zmazanie
dát po skončení eventu zodpovedá prevádzkovateľ — appka to sama neurobí.

---

## 12. Keď to nejde

| Príznak | Príčina |
|---|---|
| Prihlásenie prejde, ale hneď ťa odhlási | Beží to cez HTTP. Cookie je `secure` → krok 6 |
| Dáta zmizli po reštarte | `DATABASE_URL` nezačína `postgres://` → appka je na PGlite |
| `Príliš veľa pokusov o prihlásenie` | Rate limit, 8 pokusov / 10 min. Je to správne správanie, počkaj |
| Chat a živá dochádzka mrznú | Proxy bufferuje SSE → `proxy_buffering off` |
| Cron vracia 503 | `CRON_SECRET` nie je nastavené |
| `relation "users" does not exist` | Nezbehli migrácie → krok 4 |
| Build padá na `pg` / `pglite` | Zmizlo `serverExternalPackages` z `next.config.ts` |

Logy: `journalctl -u crew -f` (systemd), `docker logs -f crew`, alebo panel
Vercelu.

---

## Príloha — všetky premenné

Kompletný zoznam s komentármi je v [`.env.example`](.env.example).
