<?php
declare(strict_types=1);

/**
 * Vráti vývojovú inštanciu do východiskového stavu. Používa sa pred
 * prehliadačovými testami, aby začínali vždy rovnako.
 * Nikdy to nespúšťaj na ostrom webe — zmaže obsah.
 */

require __DIR__ . '/../lib/bootstrap.php';

if (Db::driver() !== 'sqlite') {
    exit("Odmietam: toto je určené len pre vývojovú SQLite inštanciu.\n");
}

foreach (['audit_log', 'rate_limits', 'subscribers', 'gallery', 'partners', 'zones', 'faqs', 'tickets', 'artists', 'blocks', 'settings', 'media', 'users', 'migrations'] as $t) {
    Db::pdo()->exec('DELETE FROM ' . $t);
}
Settings::forget();
Blocks::forget();
Media::forget();

Installer::migrate();
Installer::seed();
Installer::createFirstAdmin('majales', 'MajalesHeslo2027');

echo "Vývojová inštancia je pripravená (majales / MajalesHeslo2027).\n";
