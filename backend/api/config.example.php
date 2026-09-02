<?php
/**
 * ENZO — konfigurácia backendu
 * -----------------------------------------------------------------
 * Skopíruj tento súbor ako `config.php` a vyplň údaje.
 * `config.php` NIKDY nepatrí do gitu ani do verejného balíka.
 */

return [

    /* ---------- Databáza ---------- */
    'db' => [
        // 'mysql' pre Websupport, 'sqlite' ak nechceš riešiť databázu
        'driver'   => 'mysql',

        // MySQL (údaje nájdeš vo Websupporte v sekcii Databázy)
        'host'     => 'localhost',
        'port'     => 3306,
        'database' => 'enzo',
        'username' => 'enzo',
        'password' => '',
        'charset'  => 'utf8mb4',

        // SQLite — súbor v priečinku storage/ (ten je zvonku zamknutý cez .htaccess).
        // Ak máš prístup nad web root, pokojne sem daj cestu mimo verejného priečinka.
        'sqlite_path' => __DIR__ . '/../storage/enzo.sqlite',
    ],

    /* ---------- Adresa webu ---------- */
    'app' => [
        'url'      => 'https://enzo.sk',   // bez lomítka na konci
        'timezone' => 'Europe/Bratislava',
        'locale'   => 'sk_SK',
        // Náhodný reťazec — použije sa na podpisovanie tokenov objednávok.
        // Vygeneruj napr. na https://randomkeygen.com (aspoň 32 znakov).
        'secret'   => 'ZMEN-MA-NA-DLHY-NAHODNY-RETAZEC',
    ],

    /* ---------- Odosielanie e-mailov ---------- */
    'mail' => [
        // 'smtp' (odporúčané) alebo 'mail' (PHP mail(), často končí v spame)
        'transport' => 'smtp',

        'host'       => 'smtp.websupport.sk',
        'port'       => 465,
        'encryption' => 'ssl',            // 'ssl' pre 465, 'tls' pre 587
        'username'   => 'objednavky@enzo.sk',
        'password'   => '',

        'from_email' => 'objednavky@enzo.sk',
        'from_name'  => 'ENZO Smash Burgers & Pizza',

        // Kam chodia upozornenia na nové objednávky (viac adries oddeľ čiarkou)
        'shop_notify' => 'objednavky@enzo.sk',

        // Kópia každého dokladu pre účtovníčku (nechaj prázdne ak netreba)
        'accounting_bcc' => '',
    ],

    /* ---------- Platby ---------- */
    'payments' => [
        // Hotovosť pri prevzatí — zapnuté/vypnuté
        'cash_enabled' => true,

        // Platba kartou cez Stripe Checkout.
        // Kým sú kľúče prázdne, karta sa v pokladni vôbec neponúkne.
        'stripe' => [
            'enabled'         => false,
            'secret_key'      => '',      // sk_test_… alebo sk_live_…
            'publishable_key' => '',      // pk_test_… alebo pk_live_…
            'webhook_secret'  => '',      // whsec_… z nastavení webhooku
        ],
    ],

    /* ---------- Účtovníctvo ---------- */
    'accounting' => [
        // Prevádzka je platiteľ DPH? Ak nie, na doklade sa DPH neuvádza.
        'vat_payer'   => false,
        'vat_number'  => '',              // IČ DPH, ak je platiteľom
        // Sadzby DPH pre jedlo a nápoje (v %). Použije sa iba ak vat_payer = true.
        'vat_food'    => 19.0,
        'vat_drinks'  => 23.0,
        // Predvoľba číselného radu dokladov
        'doc_prefix'  => 'ENZO',
    ],

    /* ---------- Bezpečnosť ---------- */
    'security' => [
        // Odkiaľ smie web volať API. Doplň všetky domény vrátane www.
        'allowed_origins' => ['https://enzo.sk', 'https://www.enzo.sk'],
        // Maximálny počet objednávok z jednej IP za hodinu
        'rate_limit_per_hour' => 12,
    ],
];
