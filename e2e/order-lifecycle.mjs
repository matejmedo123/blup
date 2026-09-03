/**
 * E2E — celý životný cyklus objednávky.
 *
 * Zákazník objedná na mobile, prevádzka objednávku prijme a preklikáva
 * ju cez všetky stavy, zákazník to celý čas vidí na stránke objednávky.
 *
 * Beží proti testovaciemu serveru pripravenému cez `scripts/dev-server.sh`.
 *
 *   node e2e/order-lifecycle.mjs
 *   BASE=http://127.0.0.1:8080 node e2e/order-lifecycle.mjs
 */

import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
const EMAIL = process.env.ADMIN_EMAIL ?? "prevadzka@enzo.sk";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "EnzoTest12345";
const EXECUTABLE = process.env.CHROMIUM_PATH ?? undefined;

/* Mobil je pre zákazníka hlavné zariadenie, tak testujeme na ňom. */
const PHONE = { width: 390, height: 844 };
/* Prevádzka býva pri tablete alebo notebooku, ale musí to ísť aj z mobilu. */
const TABLET = { width: 820, height: 1180 };

let passed = 0;
let failed = 0;
const failures = [];

function ok(condition, label, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    return;
  }
  failed++;
  failures.push(label + (detail ? ` (${detail})` : ""));
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ""}`);
}

function is(actual, expected, label) {
  ok(actual === expected, label, actual === expected ? "" : `čakal som ${expected}, dostal ${actual}`);
}

function step(name) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});

  const customer = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  const shop = await browser.newContext({ viewport: TABLET });

  const page = await customer.newPage();
  const admin = await shop.newPage();

  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(`zákazník: ${e.message}`));
  admin.on("pageerror", (e) => jsErrors.push(`admin: ${e.message}`));
  admin.on("dialog", (d) => d.accept());

  try {
    /* ---------------------------------------------------------------- */
    step("1. Zákazník si prezerá menu na mobile");

    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await wait(1200);

    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    ok(overflow.scroll <= overflow.client + 1, "stránka sa na mobile neposúva do strán",
      `${overflow.scroll} > ${overflow.client}`);

    const cards = await page.locator("#menu article").count();
    ok(cards > 0, `menu sa načítalo (${cards} položiek v kategórii)`);

    /* ---------------------------------------------------------------- */
    step("2. Vloží položky do košíka");

    // Toľko, aby sme prebili minimálnu objednávku
    for (let i = 0; i < 3; i++) {
      const card = page.locator("#menu article").nth(i);
      const button = card.getByRole("button", { name: /pridať|prispôsobiť/i });
      if ((await button.count()) === 0 || (await button.isDisabled())) continue;
      await button.click();
      await wait(500);

      const modal = page.getByRole("dialog");
      if (await modal.count()) {
        const cta = modal.getByRole("button").last();
        if (await cta.isDisabled()) {
          // Povinná skupina (napr. veľkosť) — vyberieme prvú možnosť.
          await modal.locator('input[name^="group-"]').first().locator("..").click();
          await wait(250);
        }
        await cta.click();
        await wait(500);
      }
    }

    await page.getByRole("button", { name: /košík/i }).first().click();
    await wait(700);
    const drawer = await page.getByRole("dialog", { name: "Košík" }).innerText();
    ok(/celkom/i.test(drawer), "košík ukazuje celkovú sumu", drawer.slice(0, 120).replace(/\n/g, " · "));

    /* ---------------------------------------------------------------- */
    step("3. Prejde pokladňou");

    await page.getByRole("button", { name: /pokladňa/i }).first().click();
    await page.waitForURL("**/pokladna/**", { timeout: 15000 });

    await page.getByRole("radio", { name: /osobný odber/i }).click();
    await page.fill("#firstName", "Marek");
    await page.fill("#lastName", "Skúšobný");
    await page.fill("#phone", "0905 111 222");
    await page.fill("#email", "marek@example.sk");

    const slot = page.locator("#pickupTime");
    if (await slot.count()) await slot.selectOption({ index: 1 });
    await page.locator("#terms").click({ force: true });

    const payments = await page.locator("input[name=payment]").evaluateAll((n) => n.map((x) => x.value));
    ok(payments.length > 0, `pokladňa ponúka platbu (${payments.join(", ")})`);

    await page.getByRole("button", { name: /objednať|odoslať|dokončiť/i }).last().click();
    await page.waitForURL("**/objednavka/**", { timeout: 20000 });
    await wait(1500);

    const confirmation = await page.locator("main").innerText();
    const orderNumber = (confirmation.match(/ENZO-\d+/) ?? [])[0];
    ok(Boolean(orderNumber), `objednávka vznikla (${orderNumber ?? "bez čísla"})`);
    ok(/prijat/i.test(confirmation), "zákazník vidí, že je objednávka prijatá");

    const orderUrl = page.url();

    /* ---------------------------------------------------------------- */
    step("4. Prevádzka objednávku vidí a prijme");

    await admin.goto(`${BASE}/admin/`, { waitUntil: "networkidle" });
    await admin.fill("input[name=email]", EMAIL);
    await admin.fill("input[name=password]", PASSWORD);
    await admin.click("button[type=submit]");
    await admin.waitForURL("**/dashboard.php", { timeout: 15000 });
    await wait(2000);

    const newTab = admin.locator('#boardTabs button[data-tab="received"]');
    if ((await newTab.count()) > 0 && (await newTab.isVisible())) {
      await newTab.click();
      await wait(400);
    }

    const card = admin.locator(".order-card").filter({ hasText: orderNumber });
    ok((await card.count()) > 0, "objednávka je na nástenke medzi novými");

    await card.locator('.mins button[data-mins="20"]').click();
    await card.locator('button[data-act="accept"]').click();
    await wait(2500);

    /* ---------------------------------------------------------------- */
    step("5. Zákazníkovi sa ukáže potvrdený čas");

    await page.goto(orderUrl, { waitUntil: "networkidle" });
    await wait(1500);
    const withTime = await page.locator("main").innerText();
    ok(/hotové o\s*\d{1,2}:\d{2}/i.test(withTime), "na stránke objednávky je čas, kedy bude hotová");
    ok(/20 minút/.test(withTime), "aj počet minút, ktoré prevádzka odklikla");

    /* ---------------------------------------------------------------- */
    step("6. Prevádzka objednávku preklikáva ďalej");

    /**
     * Na úzkych displejoch je nástenka v režime záložiek, takže sa treba
     * najprv prepnúť na stĺpec, v ktorom objednávka práve je.
     */
    const showTab = async (tab) => {
      const button = admin.locator(`#boardTabs button[data-tab="${tab}"]`);
      if ((await button.count()) > 0 && (await button.isVisible())) {
        await button.click();
        await wait(400);
      }
    };

    const act = async (action, label, tab) => {
      await showTab(tab);
      const target = admin.locator(".order-card").filter({ hasText: orderNumber });
      const button = target.locator(`button[data-act="${action}"]`);
      ok((await button.count()) > 0, `tlačidlo „${label}“ je k dispozícii`);
      if (await button.count()) {
        await button.first().click();
        await wait(2200);
      }
    };

    await act("preparing", "na platni", "working");
    await act("ready", "hotové", "working");
    await act("picked_up", "vyzdvihnuté", "ready");
    await act("complete", "vybavené", "ready");

    await wait(1500);
    const stillOnBoard = await admin.locator(".order-card").filter({ hasText: orderNumber }).count();
    is(stillOnBoard, 0, "vybavená objednávka zmizla z nástenky");

    /* ---------------------------------------------------------------- */
    step("7. Zákazník vidí, že je vybavená");

    await page.goto(orderUrl, { waitUntil: "networkidle" });
    await wait(1500);
    const finalText = await page.locator("main").innerText();
    ok(/vybaven/i.test(finalText), "stav objednávky je vybavená");

    /* ---------------------------------------------------------------- */
    step("8. Neplatný prechod prevádzka nespraví");

    const history = await admin.goto(`${BASE}/admin/orders-history.php`, { waitUntil: "networkidle" });
    ok(history?.ok() ?? false, "história objednávok sa načíta");
    const historyText = await admin.locator("body").innerText();
    ok(historyText.includes(orderNumber), "vybavená objednávka je v histórii");

    /* ---------------------------------------------------------------- */
    step("9. Bez chýb v prehliadači");
    ok(jsErrors.length === 0, "žiadne chyby v konzole", jsErrors.join(" | "));
  } finally {
    await browser.close();
  }

  console.log("\n" + "─".repeat(52));
  if (failed === 0) {
    console.log(`\x1b[32mVšetkých ${passed} E2E kontrol prešlo.\x1b[0m`);
    process.exit(0);
  }
  console.log(`\x1b[31m${failed} z ${passed + failed} E2E kontrol zlyhalo:\x1b[0m`);
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}

main().catch((err) => {
  console.error("\x1b[31mE2E test spadol:\x1b[0m", err.message);
  process.exit(1);
});
