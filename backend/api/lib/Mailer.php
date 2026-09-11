<?php
declare(strict_types=1);

/**
 * Odosielanie e-mailov cez SMTP bez externých knižníc.
 * Na zdieľanom hostingu je SMTP spoľahlivejšie než mail() — správy
 * menej často končia v spame, lebo idú cez overenú schránku.
 */
final class Mailer
{
    /** @param array<string,mixed> $cfg */
    public function __construct(private array $cfg)
    {
    }

    /**
     * @param string|list<string> $to
     * @return array{ok:bool,error:?string,logged:bool}
     */
    public function send(
        string|array $to,
        string $subject,
        string $html,
        string $text,
        ?string $replyTo = null,
        string|array|null $bcc = null,
    ): array {
        $recipients = is_array($to) ? $to : array_map('trim', explode(',', $to));
        $recipients = array_values(array_filter($recipients, static fn ($e) => filter_var($e, FILTER_VALIDATE_EMAIL)));
        if ($recipients === []) {
            return ['ok' => false, 'error' => 'Chýba platný príjemca.', 'logged' => false];
        }
        $bccList = [];
        if ($bcc !== null) {
            $bccList = is_array($bcc) ? $bcc : array_map('trim', explode(',', $bcc));
            $bccList = array_values(array_filter($bccList, static fn ($e) => filter_var($e, FILTER_VALIDATE_EMAIL)));
        }

        $boundary = 'enzo-' . bin2hex(random_bytes(12));
        $headers  = $this->headers($recipients, $subject, $boundary, $replyTo);
        $body     = $this->body($html, $text, $boundary);

        $transport = (string) ($this->cfg['transport'] ?? 'smtp');

        try {
            if ($transport === 'log') {
                // Vývojový režim: e-mail sa neodošle, odloží sa na disk.
                // Patrí to sem, nie do volajúceho — inak by každé miesto,
                // ktoré posiela poštu, muselo na tento režim myslieť samo.
                $this->sendToFile($recipients, $subject, $html, $text);
                return ['ok' => true, 'error' => null, 'logged' => true];
            }
            if ($transport === 'smtp') {
                $this->sendSmtp(array_merge($recipients, $bccList), $headers, $body);
            } else {
                $this->sendMailFunction($recipients, $subject, $headers, $body, $bccList);
            }
            return ['ok' => true, 'error' => null, 'logged' => false];
        } catch (Throwable $e) {
            return ['ok' => false, 'error' => $e->getMessage(), 'logged' => false];
        }
    }

    /** @param list<string> $recipients */
    private function headers(array $recipients, string $subject, string $boundary, ?string $replyTo): string
    {
        $fromName  = $this->encodeHeader((string) $this->cfg['from_name']);
        $fromEmail = (string) $this->cfg['from_email'];

        $h = [];
        $h[] = 'Date: ' . date('r');
        $h[] = 'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $this->hostFromEmail($fromEmail) . '>';
        $h[] = "From: $fromName <$fromEmail>";
        $h[] = 'To: ' . implode(', ', $recipients);
        $h[] = 'Subject: ' . $this->encodeHeader($subject);
        if ($replyTo !== null && filter_var($replyTo, FILTER_VALIDATE_EMAIL)) {
            $h[] = "Reply-To: $replyTo";
        }
        $h[] = 'MIME-Version: 1.0';
        $h[] = "Content-Type: multipart/alternative; boundary=\"$boundary\"";
        $h[] = 'X-Mailer: ENZO';
        return implode("\r\n", $h);
    }

    private function body(string $html, string $text, string $boundary): string
    {
        $b = [];
        $b[] = "--$boundary";
        $b[] = 'Content-Type: text/plain; charset=UTF-8';
        $b[] = 'Content-Transfer-Encoding: base64';
        $b[] = '';
        $b[] = chunk_split(base64_encode($text));
        $b[] = "--$boundary";
        $b[] = 'Content-Type: text/html; charset=UTF-8';
        $b[] = 'Content-Transfer-Encoding: base64';
        $b[] = '';
        $b[] = chunk_split(base64_encode($html));
        $b[] = "--$boundary--";
        return implode("\r\n", $b);
    }

    /** @param list<string> $recipients */
    private function sendSmtp(array $recipients, string $headers, string $body): void
    {
        $host = (string) $this->cfg['host'];
        $port = (int) $this->cfg['port'];
        $enc  = (string) ($this->cfg['encryption'] ?? 'ssl');

        $target = $enc === 'ssl' ? "ssl://$host:$port" : "$host:$port";
        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
        $fp = @stream_socket_client($target, $errno, $errstr, 20, STREAM_CLIENT_CONNECT, $ctx);
        if (!$fp) {
            throw new RuntimeException("SMTP pripojenie zlyhalo: $errstr ($errno)");
        }
        stream_set_timeout($fp, 20);

        $expect = function (array $codes) use ($fp): string {
            $line = '';
            do {
                $chunk = fgets($fp, 1024);
                if ($chunk === false) {
                    throw new RuntimeException('SMTP: server neodpovedal.');
                }
                $line = $chunk;
            } while (isset($line[3]) && $line[3] === '-');
            $code = (int) substr($line, 0, 3);
            if (!in_array($code, $codes, true)) {
                throw new RuntimeException('SMTP odpoveď: ' . trim($line));
            }
            return $line;
        };
        $cmd = function (string $c) use ($fp): void {
            fwrite($fp, $c . "\r\n");
        };

        $expect([220]);
        $cmd('EHLO ' . ($_SERVER['SERVER_NAME'] ?? 'localhost'));
        $expect([250]);

        if ($enc === 'tls') {
            $cmd('STARTTLS');
            $expect([220]);
            if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new RuntimeException('SMTP: STARTTLS zlyhalo.');
            }
            $cmd('EHLO ' . ($_SERVER['SERVER_NAME'] ?? 'localhost'));
            $expect([250]);
        }

        if (!empty($this->cfg['username'])) {
            $cmd('AUTH LOGIN');
            $expect([334]);
            $cmd(base64_encode((string) $this->cfg['username']));
            $expect([334]);
            $cmd(base64_encode((string) $this->cfg['password']));
            $expect([235]);
        }

        $cmd('MAIL FROM:<' . $this->cfg['from_email'] . '>');
        $expect([250]);
        foreach ($recipients as $r) {
            $cmd("RCPT TO:<$r>");
            $expect([250, 251]);
        }
        $cmd('DATA');
        $expect([354]);

        // riadky začínajúce bodkou treba zdvojiť (SMTP dot-stuffing)
        $data = preg_replace('/^\./m', '..', $headers . "\r\n\r\n" . $body);
        $cmd($data . "\r\n.");
        $expect([250]);
        $cmd('QUIT');
        fclose($fp);
    }

    /** @param list<string> $recipients */
    private function sendToFile(array $recipients, string $subject, string $html, string $text): void
    {
        $dir = __DIR__ . '/../../storage/mail';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException('Priečinok storage/mail sa nedá vytvoriť.');
        }
        $slug = trim(preg_replace('/[^a-z0-9]+/i', '-', $subject) ?? '', '-');
        $file = $dir . '/' . date('Ymd-His') . '-' . mb_strtolower(mb_substr($slug, 0, 40)) . '-' . bin2hex(random_bytes(3));
        if (@file_put_contents($file . '.html', $html) === false) {
            throw new RuntimeException('Do storage/mail sa nedá zapisovať.');
        }
        file_put_contents($file . '.txt', 'To: ' . implode(', ', $recipients) . "\nSubject: $subject\n\n" . $text);
    }

    /** @param list<string> $recipients @param list<string> $bcc */
    private function sendMailFunction(array $recipients, string $subject, string $headers, string $body, array $bcc): void
    {
        // mail() si hlavičky To a Subject skladá sám
        $lines = array_filter(
            explode("\r\n", $headers),
            static fn ($l) => !str_starts_with($l, 'To: ') && !str_starts_with($l, 'Subject: ')
        );
        if ($bcc !== []) {
            $lines[] = 'Bcc: ' . implode(', ', $bcc);
        }
        $ok = mail(
            implode(', ', $recipients),
            $this->encodeHeader($subject),
            $body,
            implode("\r\n", $lines)
        );
        if (!$ok) {
            throw new RuntimeException('mail() vrátilo chybu.');
        }
    }

    private function encodeHeader(string $value): string
    {
        return preg_match('/[\x80-\xFF]/', $value)
            ? '=?UTF-8?B?' . base64_encode($value) . '?='
            : $value;
    }

    private function hostFromEmail(string $email): string
    {
        $parts = explode('@', $email);
        return $parts[1] ?? 'localhost';
    }
}
