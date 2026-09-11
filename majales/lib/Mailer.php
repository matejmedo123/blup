<?php
declare(strict_types=1);

/**
 * Odosielanie e-mailov. Na Websupporte stačí funkcia mail(); pre istotu
 * je tu aj SMTP a režim „file", ktorý pri vývoji iba uloží správu na disk.
 * Zlyhanie odoslania sa zaloguje a nikdy nezhodí stránku návštevníkovi.
 */
final class Mailer
{
    public static function send(string $to, string $subject, string $html, string $text = ''): bool
    {
        $from     = (string) Config::get('mail.from', 'web@majalesnitra.sk');
        $fromName = (string) Config::get('mail.from_name', 'Majáles Nitra');
        $replyTo  = (string) Config::get('mail.reply_to', $from);
        $text     = $text !== '' ? $text : self::toText($html);

        $boundary = 'majales-' . bin2hex(random_bytes(8));
        $headers  = [
            'MIME-Version: 1.0',
            'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
            'From: ' . self::encodeName($fromName) . ' <' . $from . '>',
            'Reply-To: ' . $replyTo,
            'X-Mailer: Majales',
        ];

        $body = "--$boundary\r\n"
            . "Content-Type: text/plain; charset=UTF-8\r\n"
            . "Content-Transfer-Encoding: 8bit\r\n\r\n"
            . $text . "\r\n\r\n"
            . "--$boundary\r\n"
            . "Content-Type: text/html; charset=UTF-8\r\n"
            . "Content-Transfer-Encoding: 8bit\r\n\r\n"
            . $html . "\r\n\r\n"
            . "--$boundary--\r\n";

        $encodedSubject = self::encodeName($subject);

        try {
            return match ((string) Config::get('mail.transport', 'mail')) {
                'file' => self::toFile($to, $subject, $body),
                'smtp' => self::viaSmtp($to, $encodedSubject, $headers, $body),
                default => @mail($to, $encodedSubject, $body, implode("\r\n", $headers)),
            };
        } catch (Throwable $e) {
            error_log('Mailer: ' . $e->getMessage());
            return false;
        }
    }

    private static function encodeName(string $value): string
    {
        // Diakritika v predmete aj v mene odosielateľa potrebuje MIME kódovanie.
        return preg_match('/[\x80-\xFF]/', $value) === 1
            ? '=?UTF-8?B?' . base64_encode($value) . '?='
            : $value;
    }

    private static function toFile(string $to, string $subject, string $body): bool
    {
        $dir = MAJALES_ROOT . '/storage/mail';
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        $file = $dir . '/' . date('Ymd-His', Clock::timestamp()) . '-' . Validate::slug($to) . '.eml';
        return file_put_contents($file, "To: $to\nSubject: $subject\n\n$body") !== false;
    }

    /** @param list<string> $headers */
    private static function viaSmtp(string $to, string $subject, array $headers, string $body): bool
    {
        $host = (string) Config::get('mail.smtp.host', '');
        $port = (int) Config::get('mail.smtp.port', 465);
        $enc  = (string) Config::get('mail.smtp.encryption', 'ssl');
        $user = (string) Config::get('mail.smtp.username', '');
        $pass = (string) Config::get('mail.smtp.password', '');
        if ($host === '') {
            throw new RuntimeException('SMTP nie je nastavené.');
        }

        $target = ($enc === 'ssl' ? 'ssl://' : '') . $host . ':' . $port;
        $fp = @stream_socket_client($target, $errno, $errstr, 20);
        if ($fp === false) {
            throw new RuntimeException("SMTP spojenie zlyhalo: $errstr ($errno)");
        }
        stream_set_timeout($fp, 20);

        $read = static function () use ($fp): string {
            $out = '';
            while (($line = fgets($fp, 1024)) !== false) {
                $out .= $line;
                if (strlen($line) < 4 || $line[3] === ' ') {
                    break;
                }
            }
            return $out;
        };
        $cmd = static function (string $line, string $expect) use ($fp, $read): void {
            fwrite($fp, $line . "\r\n");
            $resp = $read();
            if (!str_starts_with($resp, $expect)) {
                throw new RuntimeException('SMTP: ' . trim($line) . ' → ' . trim($resp));
            }
        };

        try {
            $read();
            $cmd('EHLO ' . (parse_url(Config::baseUrl(), PHP_URL_HOST) ?: 'localhost'), '250');
            if ($enc === 'tls') {
                $cmd('STARTTLS', '220');
                if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                    throw new RuntimeException('SMTP: STARTTLS zlyhalo.');
                }
                $cmd('EHLO ' . (parse_url(Config::baseUrl(), PHP_URL_HOST) ?: 'localhost'), '250');
            }
            if ($user !== '') {
                $cmd('AUTH LOGIN', '334');
                $cmd(base64_encode($user), '334');
                $cmd(base64_encode($pass), '235');
            }
            $cmd('MAIL FROM:<' . Config::get('mail.from', '') . '>', '250');
            $cmd('RCPT TO:<' . $to . '>', '250');
            $cmd('DATA', '354');

            $data = 'To: ' . $to . "\r\n" . 'Subject: ' . $subject . "\r\n"
                . implode("\r\n", $headers) . "\r\n\r\n"
                // Riadok začínajúci bodkou by predčasne ukončil správu.
                . preg_replace('/^\./m', '..', $body) . "\r\n.";
            $cmd($data, '250');
            $cmd('QUIT', '221');
            return true;
        } finally {
            fclose($fp);
        }
    }

    private static function toText(string $html): string
    {
        $text = preg_replace('#<br\s*/?>#i', "\n", $html) ?? $html;
        $text = preg_replace('#</(p|div|tr|h[1-6])>#i', "\n\n", $text) ?? $text;
        return trim(html_entity_decode(strip_tags($text), ENT_QUOTES, 'UTF-8'));
    }
}
