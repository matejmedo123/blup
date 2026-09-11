<?php
declare(strict_types=1);

/**
 * Odber noviniek z pätičky. Opakované odoslanie rovnakého e-mailu
 * nevytvorí druhý záznam — len potvrdí, že odber beží.
 */
final class Subscribers
{
    public const STATUS_ACTIVE       = 'active';
    public const STATUS_UNSUBSCRIBED = 'unsubscribed';

    /**
     * Prihlási e-mail na odber. Vracia `created` (nový), `already`
     * (už bol prihlásený) alebo `resubscribed` (bol odhlásený a vrátil sa).
     */
    public static function subscribe(string $email, string $source = 'web'): string
    {
        $email   = mb_strtolower(trim($email));
        $ipHash  = hash('sha256', RateLimit::clientIp() . '|' . Config::get('app.app_key', ''));
        $existing = Db::one('SELECT * FROM subscribers WHERE email = ?', [$email]);

        if ($existing === null) {
            Db::insert('subscribers', [
                'email'      => $email,
                'token'      => bin2hex(random_bytes(24)),
                'status'     => self::STATUS_ACTIVE,
                'source'     => mb_substr($source, 0, 40),
                'ip_hash'    => $ipHash,
                'created_at' => Clock::now(),
            ]);
            return 'created';
        }

        if ($existing['status'] === self::STATUS_ACTIVE) {
            return 'already';
        }

        Db::update('subscribers', (int) $existing['id'], [
            'status'          => self::STATUS_ACTIVE,
            'unsubscribed_at' => null,
        ]);
        return 'resubscribed';
    }

    /** Odhlásenie cez odkaz z e-mailu. Vracia, či sa niekoho týkalo. */
    public static function unsubscribeByToken(string $token): bool
    {
        if ($token === '') {
            return false;
        }
        $row = Db::one('SELECT * FROM subscribers WHERE token = ?', [$token]);
        if ($row === null) {
            return false;
        }
        if ($row['status'] !== self::STATUS_ACTIVE) {
            return true;
        }
        Db::update('subscribers', (int) $row['id'], [
            'status'          => self::STATUS_UNSUBSCRIBED,
            'unsubscribed_at' => Clock::now(),
        ]);
        return true;
    }

    public static function unsubscribeUrl(string $token): string
    {
        return Config::baseUrl() . '/api/odhlasit.php?t=' . urlencode($token);
    }

    /** @return list<array<string,mixed>> */
    public static function listAll(string $status = '', int $limit = 500, int $offset = 0): array
    {
        $limit  = max(1, min(2000, $limit));
        $offset = max(0, $offset);
        if ($status !== '') {
            return Db::all(
                "SELECT * FROM subscribers WHERE status = ? ORDER BY id DESC LIMIT $limit OFFSET $offset",
                [$status]
            );
        }
        return Db::all("SELECT * FROM subscribers ORDER BY id DESC LIMIT $limit OFFSET $offset");
    }

    public static function count(string $status = ''): int
    {
        if ($status !== '') {
            return (int) Db::value('SELECT COUNT(*) FROM subscribers WHERE status = ?', [$status]);
        }
        return (int) Db::value('SELECT COUNT(*) FROM subscribers');
    }

    public static function remove(int $id): void
    {
        Db::delete('subscribers', $id);
    }

    /** Export do CSV pre newsletterový nástroj. */
    public static function toCsv(string $status = self::STATUS_ACTIVE): string
    {
        $rows = self::listAll($status, 2000);
        $fh   = fopen('php://temp', 'r+');
        if ($fh === false) {
            return '';
        }
        // Excel na Windows číta CSV v UTF-8 správne až s touto značkou.
        fwrite($fh, "\xEF\xBB\xBF");
        fputcsv($fh, ['E-mail', 'Stav', 'Zdroj', 'Prihlásený'], ';', '"', '\\');
        foreach ($rows as $r) {
            fputcsv($fh, [
                $r['email'],
                $r['status'] === self::STATUS_ACTIVE ? 'aktívny' : 'odhlásený',
                $r['source'],
                $r['created_at'],
            ], ';', '"', '\\');
        }
        rewind($fh);
        $csv = (string) stream_get_contents($fh);
        fclose($fh);
        return $csv;
    }

    /** Uvítací e-mail. Keď sa nepodarí odoslať, odber aj tak platí. */
    public static function sendWelcome(string $email): void
    {
        $row = Db::one('SELECT token FROM subscribers WHERE email = ?', [$email]);
        if ($row === null) {
            return;
        }
        $unsub = self::unsubscribeUrl((string) $row['token']);
        $title = Settings::get('site_title', 'Majáles Nitra');

        $html = '<div style="font-family:Arial,Helvetica,sans-serif;background:#0A4E85;color:#ffffff;padding:32px">'
            . '<h1 style="color:#FFF200;margin:0 0 16px">Vitaj na Majálesi!</h1>'
            . '<p style="font-size:16px;line-height:1.6">Ďakujeme za prihlásenie na odber noviniek. Ozveme sa, keď zverejníme ďalšie mená v lineupe a keď spustíme predaj vstupeniek.</p>'
            . '<p style="font-size:16px;line-height:1.6">Tešíme sa na teba <strong>' . Html::e(Settings::get('site_tagline', '')) . '</strong>.</p>'
            . '<p style="font-size:12px;opacity:0.8;margin-top:28px">Ak si sa neprihlásil ty, odber zrušíš tu: <a style="color:#FFF200" href="' . Html::e($unsub) . '">odhlásiť</a>.</p>'
            . '</div>';

        Mailer::send($email, $title . ' — potvrdenie odberu', $html);
    }

    /** Upozornenie pre organizátora, keď si to v nastaveniach praje. */
    public static function notifyOrganiser(string $email): void
    {
        $to = trim(Settings::get('newsletter_notify_email', ''));
        if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
            return;
        }
        Mailer::send(
            $to,
            'Nový odberateľ noviniek',
            '<p>Na odber noviniek sa prihlásil: <strong>' . Html::e($email) . '</strong></p>'
            . '<p>Spolu aktívnych odberateľov: ' . self::count(self::STATUS_ACTIVE) . '</p>'
        );
    }
}
