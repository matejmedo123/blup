<?php
declare(strict_types=1);

/**
 * Rozosielanie e-mailov k objednávke + zápis do mail_log,
 * aby sa dalo v admine dohľadať, čo a kedy odišlo.
 */
final class Notifier
{
    private MailTemplates $t;
    private Mailer $mailer;

    /** @param array<string,mixed> $mailCfg */
    public function __construct(private array $mailCfg, private string $appUrl)
    {
        $this->t      = new MailTemplates($appUrl);
        $this->mailer = new Mailer($mailCfg);
    }

    public function orderReceived(array $o): void
    {
        $m = $this->t->orderReceived($o);
        $this->deliver(
            (string) $o['email'],
            $m,
            'order_received',
            (int) $o['id'],
            bcc: (string) ($this->mailCfg['accounting_bcc'] ?? '')
        );
    }

    public function shopNewOrder(array $o): void
    {
        $adminUrl = rtrim($this->appUrl, '/') . '/admin/order.php?id=' . (int) $o['id'];
        $m = $this->t->shopNewOrder($o, $adminUrl);
        $this->deliver(
            (string) ($this->mailCfg['shop_notify'] ?? ''),
            $m,
            'shop_new_order',
            (int) $o['id'],
            replyTo: (string) $o['email']
        );
    }

    public function orderConfirmed(array $o): void
    {
        $this->deliver((string) $o['email'], $this->t->orderConfirmed($o), 'order_confirmed', (int) $o['id']);
    }

    public function orderReady(array $o): void
    {
        $this->deliver((string) $o['email'], $this->t->orderReady($o), 'order_ready', (int) $o['id']);
    }

    public function orderCancelled(array $o, string $reason): void
    {
        $this->deliver((string) $o['email'], $this->t->orderCancelled($o, $reason), 'order_cancelled', (int) $o['id']);
    }

    /** @param array{subject:string,html:string,text:string} $m */
    private function deliver(
        string $to,
        array $m,
        string $template,
        ?int $orderId,
        ?string $replyTo = null,
        string $bcc = '',
    ): void {
        if (trim($to) === '') {
            return;
        }

        // vývojový režim: e-maily sa neposielajú, iba ukladajú na disk
        if (($this->mailCfg['transport'] ?? '') === 'log') {
            $dir = __DIR__ . '/../../storage/mail';
            if (!is_dir($dir)) {
                @mkdir($dir, 0775, true);
            }
            $file = $dir . '/' . date('Ymd-His') . '-' . $template . '-' . bin2hex(random_bytes(3));
            file_put_contents($file . '.html', $m['html']);
            file_put_contents(
                $file . '.txt',
                "To: $to\nSubject: {$m['subject']}\n\n{$m['text']}"
            );
            $this->log($orderId, $to, $m['subject'], $template, 'logged', null);
            return;
        }

        $res = $this->mailer->send($to, $m['subject'], $m['html'], $m['text'], $replyTo, $bcc ?: null);
        $this->log($orderId, $to, $m['subject'], $template, $res['ok'] ? 'sent' : 'failed', $res['error']);
        if (!$res['ok']) {
            error_log("Mail $template pre $to zlyhal: " . (string) $res['error']);
        }
    }

    private function log(?int $orderId, string $to, string $subject, string $template, string $status, ?string $error): void
    {
        try {
            Db::insert('mail_log', [
                'order_id'   => $orderId,
                'recipient'  => mb_substr($to, 0, 190),
                'subject'    => mb_substr($subject, 0, 255),
                'template'   => $template,
                'status'     => $status,
                'error'      => $error,
                'created_at' => date('Y-m-d H:i:s'),
            ]);
        } catch (Throwable $e) {
            error_log('mail_log: ' . $e->getMessage());
        }
    }
}
