<?php
declare(strict_types=1);

/**
 * Skopíruj tento súbor ako config.php a vyplň údaje z Websupportu.
 * config.php nikdy nepatrí do gitu ani do ZIP balíka.
 */

return [
    'db' => [
        // 'mysql' na Websupporte, 'sqlite' keď chceš skúšať bez databázy
        'driver'      => 'mysql',
        'host'        => 'localhost',
        'port'        => 3306,
        'database'    => 'majales',
        'username'    => 'majales',
        'password'    => '',
        'charset'     => 'utf8mb4',
        'sqlite_path' => __DIR__ . '/storage/majales.sqlite',
    ],

    'app' => [
        'timezone'  => 'Europe/Bratislava',
        // Absolútna adresa webu bez lomky na konci — používa sa v e-mailoch,
        // v sitemape a v OG značkách.
        'base_url'  => 'https://www.majalesnitra.sk',
        // Kľúč na podpisovanie odhlasovacích odkazov z newslettera.
        // Vygeneruj si vlastný: php -r 'echo bin2hex(random_bytes(32));'
        'app_key'   => '',
        // Zapni len keď ladíš — vypisuje chyby priamo do stránky.
        'debug'     => false,
    ],

    'mail' => [
        // 'mail' použije funkciu mail() (na Websupporte funguje),
        // 'smtp' pošle cez SMTP server, 'file' iba uloží do storage/mail.
        'transport'  => 'mail',
        'from'       => 'web@majalesnitra.sk',
        'from_name'  => 'Majáles Nitra',
        'reply_to'   => 'info@majalesnitra.sk',
        'smtp' => [
            'host'       => 'smtp.websupport.sk',
            'port'       => 465,
            'encryption' => 'ssl',
            'username'   => '',
            'password'   => '',
        ],
    ],

    'uploads' => [
        // Maximálna veľkosť nahrávanej fotky v bajtoch (12 MB).
        'max_bytes'    => 12 * 1024 * 1024,
        // Na akú šírku sa fotky zmenšia pri nahratí.
        'max_width'    => 2000,
        'max_height'   => 2000,
        'thumb_width'  => 480,
        'webp_quality' => 82,
    ],
];
