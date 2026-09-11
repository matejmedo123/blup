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

    public function orderDelivering(array $o): void
    {
        $this->deliver((string) $o['email'], $this->t->orderDelivering($o), 'order_delivering', (int) $o['id']);
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

        // Vývojový režim (transport = log) rieši Mailer sám — správa
        // skončí v storage/mail/ a do denníka sa zapíše ako „logged“.
        $res = $this->mailer->send($to, $m['subject'], $m['html'], $m['text'], $replyTo, $bcc ?: null);
        $status = $res['ok'] ? ($res['logged'] ? 'logged' : 'sent') : 'failed';
        $this->log($orderId, $to, $m['subject'], $template, $status, $res['error']);
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
