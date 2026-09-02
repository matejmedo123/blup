<?php
declare(strict_types=1);

/**
 * Platba kartou cez Stripe Checkout — zákazník je presmerovaný na
 * zabezpečenú stránku Stripe, kde zaplatí, a vráti sa späť na web.
 *
 * Komunikuje sa priamo s REST API cez cURL, takže na hostingu netreba
 * composer ani žiadnu knižnicu.
 *
 * Ak sa raz rozhodneš pre inú bránu (GoPay, Besteron, TrustPay), stačí
 * napísať triedu s rovnakými metódami — zvyšok systému sa nemení.
 */
final class StripeGateway
{
    private const API = 'https://api.stripe.com/v1/';

    /** @param array<string,mixed> $cfg */
    public function __construct(private array $cfg, private string $appUrl)
    {
        if (($cfg['secret_key'] ?? '') === '') {
            throw new RuntimeException('Chýba Stripe secret_key.');
        }
    }

    /**
     * Vytvorí platobnú reláciu a vráti URL, kam presmerovať zákazníka.
     * @param array<string,mixed> $order
     */
    public function createCheckout(array $order): string
    {
        $params = [
            'mode'                 => 'payment',
            'client_reference_id'  => (string) $order['order_number'],
            'customer_email'       => (string) $order['email'],
            'success_url'          => $this->returnUrl($order, 'success'),
            'cancel_url'           => $this->returnUrl($order, 'cancel'),
            'metadata[order_id]'     => (string) $order['id'],
            'metadata[order_number]' => (string) $order['order_number'],
            'locale'               => 'sk',
        ];

        $i = 0;
        foreach ($order['items'] as $item) {
            $name = (string) $item['name'];
            $extras = [];
            foreach ($item['extras'] as $e) {
                $extras[] = (string) $e['name'];
            }
            $params["line_items[$i][price_data][currency]"]              = 'eur';
            $params["line_items[$i][price_data][unit_amount]"]           = (string) (int) $item['unit_cents'];
            $params["line_items[$i][price_data][product_data][name]"]    = mb_substr($name, 0, 120);
            if ($extras !== []) {
                $params["line_items[$i][price_data][product_data][description]"] =
                    mb_substr('+ ' . implode(', ', $extras), 0, 200);
            }
            $params["line_items[$i][quantity]"] = (string) (int) $item['quantity'];
            $i++;
        }

        $delivery = (int) $order['delivery_fee_cents'];
        if ($delivery > 0) {
            $params["line_items[$i][price_data][currency]"]           = 'eur';
            $params["line_items[$i][price_data][unit_amount]"]        = (string) $delivery;
            $params["line_items[$i][price_data][product_data][name]"] = 'Doručenie';
            $params["line_items[$i][quantity]"]                       = '1';
        }

        $res = $this->post('checkout/sessions', $params);
        if (empty($res['url'])) {
            throw new RuntimeException('Stripe nevrátil URL platby.');
        }

        Db::run(
            'UPDATE orders SET payment_reference = ? WHERE id = ?',
            [(string) ($res['id'] ?? ''), (int) $order['id']]
        );
        return (string) $res['url'];
    }

    /** Overí podpis webhooku, aby sa nedal podvrhnúť. */
    public function verifyWebhook(string $payload, string $signatureHeader): array
    {
        $secret = (string) ($this->cfg['webhook_secret'] ?? '');
        if ($secret === '') {
            throw new RuntimeException('Chýba webhook_secret.');
        }

        $timestamp = null;
        $signatures = [];
        foreach (explode(',', $signatureHeader) as $part) {
            [$k, $v] = array_pad(explode('=', trim($part), 2), 2, '');
            if ($k === 't') {
                $timestamp = $v;
            } elseif ($k === 'v1') {
                $signatures[] = $v;
            }
        }
        if ($timestamp === null || $signatures === []) {
            throw new RuntimeException('Neplatná hlavička podpisu.');
        }
        if (abs(time() - (int) $timestamp) > 300) {
            throw new RuntimeException('Podpis je príliš starý.');
        }

        $expected = hash_hmac('sha256', $timestamp . '.' . $payload, $secret);
        $match = false;
        foreach ($signatures as $sig) {
            if (hash_equals($expected, $sig)) {
                $match = true;
                break;
            }
        }
        if (!$match) {
            throw new RuntimeException('Podpis nesedí.');
        }

        return json_decode($payload, true, 512, JSON_THROW_ON_ERROR);
    }

    /** Vráti aktuálny stav platby (poistka, keby webhook nedorazil). */
    public function sessionStatus(string $sessionId): array
    {
        return $this->get('checkout/sessions/' . rawurlencode($sessionId));
    }

    /* ---------------- interné ---------------- */

    private function returnUrl(array $order, string $result): string
    {
        return rtrim($this->appUrl, '/') . '/api/payment/return.php'
            . '?c=' . rawurlencode((string) $order['order_number'])
            . '&t=' . rawurlencode((string) $order['access_token'])
            . '&r=' . $result;
    }

    /** @param array<string,string> $params @return array<string,mixed> */
    private function post(string $path, array $params): array
    {
        return $this->request('POST', $path, $params);
    }

    /** @return array<string,mixed> */
    private function get(string $path): array
    {
        return $this->request('GET', $path, null);
    }

    /** @return array<string,mixed> */
    private function request(string $method, string $path, ?array $params): array
    {
        $ch = curl_init(self::API . $path);
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $this->cfg['secret_key'],
                'Stripe-Version: 2024-06-20',
            ],
        ];
        if ($method === 'POST') {
            $opts[CURLOPT_POST]       = true;
            $opts[CURLOPT_POSTFIELDS] = http_build_query($params ?? [], '', '&');
        }
        curl_setopt_array($ch, $opts);

        $raw  = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err  = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            throw new RuntimeException("Stripe: spojenie zlyhalo ($err)");
        }
        $data = json_decode((string) $raw, true);
        if (!is_array($data)) {
            throw new RuntimeException('Stripe: neplatná odpoveď.');
        }
        if ($code >= 400) {
            throw new RuntimeException('Stripe: ' . ($data['error']['message'] ?? "HTTP $code"));
        }
        return $data;
    }
}
