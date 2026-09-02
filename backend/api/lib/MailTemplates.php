<?php
declare(strict_types=1);

/**
 * E-mailové šablóny v ENZO identite.
 * HTML je postavené na tabuľkách a inline štýloch — inak si s ním
 * Outlook ani Gmail neporadia.
 */
final class MailTemplates
{
    private const BURGUNDY = '#7A1E1E';
    private const CREAM    = '#F6F0E3';
    private const INK      = '#171211';
    private const GOLD     = '#E1B12C';
    private const MUTED    = '#6E625B';

    public function __construct(private string $appUrl)
    {
    }

    /* ================================================================
       Zákazník — objednávka prijatá (obsahuje doklad)
       ================================================================ */

    /** @return array{subject:string,html:string,text:string} */
    public function orderReceived(array $o): array
    {
        $num     = $o['order_number'];
        $name    = $o['first_name'];
        $isPickup = $o['order_type'] === 'pickup';
        $link    = $this->orderLink($o);

        $intro = $isPickup
            ? 'Objednávku pripravíme a dáme ti vedieť, o koľkej si po ňu môžeš prísť.'
            : 'Objednávku pripravíme a dáme ti vedieť, kedy vyrazí kuriér.';

        $body = $this->heroBlock('Objednávka prijatá', "Ďakujeme, {$this->esc($name)}.")
            . $this->paragraph($intro)
            . $this->bigNumber('Číslo objednávky', '#' . $num)
            . $this->itemsTable($o)
            . $this->totalsTable($o)
            . $this->deliveryBlock($o)
            . $this->paymentBlock($o)
            . $this->buttonRow('Zobraziť objednávku', $link)
            . $this->paragraph(
                'Na potvrdenie času prípravy ti pošleme ďalší e-mail. '
                . 'Ak niečo nesedí, zavolaj nám na ' . $this->esc((string) Settings::get('shop_phone')) . '.',
                self::MUTED,
                13
            );

        $text = $this->textReceipt($o, "Ďakujeme, $name. Objednávka #$num bola prijatá.\n$intro")
            . "\nObjednávka online: $link\n";

        return [
            'subject' => "Objednávka #$num prijatá — ENZO",
            'html'    => $this->wrap($body, "Objednávka #$num prijatá"),
            'text'    => $text,
        ];
    }

    /* ================================================================
       Zákazník — prevádzka potvrdila čas
       ================================================================ */

    public function orderConfirmed(array $o): array
    {
        $num      = $o['order_number'];
        $isPickup = $o['order_type'] === 'pickup';
        $ready    = $o['ready_at'] ? date('H:i', strtotime((string) $o['ready_at'])) : null;
        $mins     = (int) ($o['prep_minutes'] ?? 0);

        $headline = $isPickup ? 'Pripravujeme tvoju objednávku' : 'Pripravujeme a vezieme';
        $when     = $ready !== null
            ? ($isPickup
                ? "Hotové bude o <strong>$ready</strong> (približne $mins minút)."
                : "U teba by sme mali byť okolo <strong>$ready</strong> (približne $mins minút).")
            : 'Objednávku sme prijali do prípravy.';

        $body = $this->heroBlock($headline, '#' . $num)
            . $this->timeBlock($ready, $mins, $isPickup)
            . $this->paragraph($when)
            . ($isPickup
                ? $this->paragraph(
                    'Vyzdvihnutie: <strong>' . $this->esc($this->shopAddress()) . '</strong>'
                )
                : $this->paragraph(
                    'Doručenie na: <strong>' . $this->esc($this->customerAddress($o)) . '</strong>'
                ))
            . $this->itemsTable($o)
            . $this->totalsTable($o)
            . $this->buttonRow('Zobraziť objednávku', $this->orderLink($o));

        $textWhen = $ready !== null
            ? ($isPickup ? "Hotové o $ready (približne $mins minút)." : "U teba okolo $ready (približne $mins minút).")
            : 'Objednávku sme prijali do prípravy.';

        return [
            'subject' => $ready !== null
                ? "Objednávka #$num — hotová o $ready"
                : "Objednávka #$num — pripravujeme",
            'html' => $this->wrap($body, "Objednávka #$num potvrdená"),
            'text' => "ENZO — objednávka #$num\n\n$textWhen\n\n"
                . $this->textItems($o)
                . "\nObjednávka online: " . $this->orderLink($o) . "\n",
        ];
    }

    /* ================================================================
       Zákazník — pripravené / na ceste
       ================================================================ */

    public function orderReady(array $o): array
    {
        $num      = $o['order_number'];
        $isPickup = $o['order_type'] === 'pickup';

        $headline = $isPickup ? 'Pripravené na odber' : 'Kuriér vyrazil';
        $text     = $isPickup
            ? 'Objednávka je hotová a čaká na teba na prevádzke — ' . $this->shopAddress() . '.'
            : 'Objednávka je na ceste k tebe. Ak nedvíhaš telefón, kuriér ti zazvoní.';

        $body = $this->heroBlock($headline, '#' . $num)
            . $this->paragraph($this->esc($text))
            . $this->totalsTable($o)
            . $this->paymentBlock($o);

        return [
            'subject' => $isPickup
                ? "Objednávka #$num je pripravená — ENZO"
                : "Objednávka #$num je na ceste — ENZO",
            'html' => $this->wrap($body, $headline),
            'text' => "ENZO — objednávka #$num\n\n$headline\n$text\n",
        ];
    }

    /* ================================================================
       Zákazník — zrušená
       ================================================================ */

    public function orderCancelled(array $o, string $reason): array
    {
        $num  = $o['order_number'];
        $body = $this->heroBlock('Objednávka zrušená', '#' . $num)
            . $this->paragraph($reason !== '' ? $this->esc($reason) : 'Objednávku sme museli zrušiť.')
            . $this->paragraph(
                'Ak si platil kartou, peniaze ti vrátime späť na kartu. '
                . 'S otázkami volaj na ' . $this->esc((string) Settings::get('shop_phone')) . '.',
                self::MUTED,
                13
            );

        return [
            'subject' => "Objednávka #$num bola zrušená — ENZO",
            'html'    => $this->wrap($body, 'Objednávka zrušená'),
            'text'    => "ENZO — objednávka #$num bola zrušená.\n$reason\n",
        ];
    }

    /* ================================================================
       Prevádzka — nová objednávka
       ================================================================ */

    public function shopNewOrder(array $o, string $adminUrl): array
    {
        $num      = $o['order_number'];
        $isPickup = $o['order_type'] === 'pickup';
        $type     = $isPickup ? 'OSOBNÝ ODBER' : 'ROZVOZ';
        $pay      = $o['payment_method'] === 'card'
            ? ($o['payment_status'] === 'paid' ? 'KARTA — ZAPLATENÉ' : 'KARTA — ČAKÁ NA PLATBU')
            : 'HOTOVOSŤ PRI PREVZATÍ';

        $rows = '';
        foreach ($o['items'] as $i) {
            $extras = '';
            foreach ($i['extras'] as $e) {
                $extras .= '<div style="font-size:12px;color:' . self::MUTED . '">+ ' . $this->esc((string) $e['name']) . '</div>';
            }
            if (!empty($i['note'])) {
                $extras .= '<div style="font-size:12px;color:' . self::BURGUNDY . ';font-style:italic">'
                    . $this->esc((string) $i['note']) . '</div>';
            }
            $rows .= '<tr>'
                . '<td style="padding:8px 0;border-bottom:1px solid #e6dcc8;font-size:18px;font-weight:700;width:44px">'
                . (int) $i['quantity'] . '×</td>'
                . '<td style="padding:8px 0;border-bottom:1px solid #e6dcc8"><strong>'
                . $this->esc((string) $i['name']) . '</strong>' . $extras . '</td>'
                . '<td style="padding:8px 0;border-bottom:1px solid #e6dcc8;text-align:right;white-space:nowrap">'
                . Money::format((int) $i['line_cents']) . '</td>'
                . '</tr>';
        }

        $address = $isPickup
            ? 'Odber na prevádzke' . ($o['pickup_time'] ? ' — ' . $this->esc((string) $o['pickup_time']) : '')
            : $this->esc($this->customerAddress($o));

        $body = $this->heroBlock('Nová objednávka', '#' . $num)
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">'
            . '<tr><td style="background:' . self::GOLD . ';color:' . self::INK . ';padding:12px 16px;'
            . 'font-weight:800;letter-spacing:1px;font-size:14px">' . $type . ' &nbsp;·&nbsp; ' . $pay . '</td></tr>'
            . '</table>'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' . $rows . '</table>'
            . $this->totalsTable($o)
            . $this->infoRow('Zákazník', $this->esc($o['first_name'] . ' ' . $o['last_name']))
            . $this->infoRow('Telefón', $this->esc((string) $o['phone']))
            . $this->infoRow('E-mail', $this->esc((string) $o['email']))
            . $this->infoRow($isPickup ? 'Odber' : 'Adresa', $address)
            . (!empty($o['note']) ? $this->infoRow('Poznámka', $this->esc((string) $o['note'])) : '')
            . $this->buttonRow('Otvoriť v admine a potvrdiť čas', $adminUrl);

        $text = "NOVÁ OBJEDNÁVKA #$num\n$type · $pay\n\n"
            . $this->textItems($o)
            . "\nZákazník: {$o['first_name']} {$o['last_name']}, {$o['phone']}\n"
            . ($isPickup ? "Odber: " . ($o['pickup_time'] ?? '—') : "Adresa: " . $this->customerAddress($o)) . "\n"
            . (!empty($o['note']) ? "Poznámka: {$o['note']}\n" : '')
            . "\nAdmin: $adminUrl\n";

        return [
            'subject' => "NOVÁ OBJEDNÁVKA #$num · " . Money::plain((int) $o['total_cents']) . " · $type",
            'html'    => $this->wrap($body, "Nová objednávka #$num"),
            'text'    => $text,
        ];
    }

    /* ================================================================
       Stavebné bloky
       ================================================================ */

    private function wrap(string $content, string $preheader): string
    {
        $year = date('Y');
        return '<!doctype html><html lang="sk"><head><meta charset="utf-8">'
            . '<meta name="viewport" content="width=device-width,initial-scale=1">'
            . '<title>ENZO</title></head>'
            . '<body style="margin:0;padding:0;background:#efe7d5;">'
            . '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' . $this->esc($preheader) . '</div>'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe7d5;padding:24px 12px">'
            . '<tr><td align="center">'
            . '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;'
            . 'background:' . self::CREAM . ';border-radius:14px;overflow:hidden;'
            . 'font-family:Archivo,Helvetica,Arial,sans-serif;color:' . self::INK . '">'

            /* hlavička */
            . '<tr><td style="background:' . self::BURGUNDY . ';padding:26px 28px 20px;text-align:center">'
            . '<div style="font-family:Rockwell,Georgia,\'Times New Roman\',serif;font-weight:700;font-size:42px;'
            . 'letter-spacing:1px;color:' . self::CREAM . ';line-height:1">ENZO</div>'
            . '<div style="font-size:11px;letter-spacing:3px;font-weight:700;color:' . self::CREAM . ';opacity:.75;margin-top:6px">'
            . 'SMASH BURGERS &amp; PIZZA</div>'
            . '</td></tr>'
            . '<tr><td style="height:8px;background:' . self::BURGUNDY . ';background-image:'
            . 'repeating-linear-gradient(90deg,' . self::CREAM . ' 0 8px,transparent 8px 16px)"></td></tr>'

            /* obsah */
            . '<tr><td style="padding:28px">' . $content . '</td></tr>'

            /* pätička */
            . '<tr><td style="background:' . self::BURGUNDY . ';padding:20px 28px;color:' . self::CREAM . ';font-size:12px;line-height:1.6">'
            . '<strong>' . $this->esc((string) Settings::get('shop_name')) . '</strong><br>'
            . $this->esc($this->shopAddress()) . '<br>'
            . $this->esc((string) Settings::get('shop_phone')) . ' · '
            . $this->esc((string) Settings::get('shop_email')) . '<br>'
            . '<span style="opacity:.6">' . $this->esc((string) Settings::get('company_name'))
            . ' · IČO ' . $this->esc((string) Settings::get('company_ico'))
            . ' · DIČ ' . $this->esc((string) Settings::get('company_dic')) . '</span><br>'
            . '<span style="opacity:.5">© ' . $year . ' · SMASHED FRESH. SERVED HOT.</span>'
            . '</td></tr>'

            . '</table></td></tr></table></body></html>';
    }

    private function heroBlock(string $title, string $sub): string
    {
        return '<h1 style="margin:0 0 4px;font-size:26px;line-height:1.15;text-transform:uppercase;'
            . 'font-weight:800;letter-spacing:-.4px;color:' . self::INK . '">' . $this->esc($title) . '</h1>'
            . '<p style="margin:0 0 20px;font-size:16px;color:' . self::BURGUNDY . ';font-weight:700">'
            . $this->esc($sub) . '</p>';
    }

    private function bigNumber(string $label, string $value): string
    {
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            . 'style="margin:0 0 20px;background:#fff;border-radius:10px"><tr><td style="padding:14px 18px">'
            . '<div style="font-size:10px;letter-spacing:2px;font-weight:700;color:' . self::MUTED . ';text-transform:uppercase">'
            . $this->esc($label) . '</div>'
            . '<div style="font-size:26px;font-weight:800;color:' . self::BURGUNDY . ';margin-top:4px">'
            . $this->esc($value) . '</div>'
            . '</td></tr></table>';
    }

    private function timeBlock(?string $ready, int $mins, bool $isPickup): string
    {
        if ($ready === null) {
            return '';
        }
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            . 'style="margin:0 0 20px;background:' . self::GOLD . ';border-radius:10px"><tr><td style="padding:18px;text-align:center">'
            . '<div style="font-size:11px;letter-spacing:2px;font-weight:800;color:' . self::INK . ';text-transform:uppercase">'
            . ($isPickup ? 'Hotové o' : 'U teba okolo') . '</div>'
            . '<div style="font-size:40px;font-weight:800;color:' . self::INK . ';line-height:1.1;margin-top:2px">'
            . $this->esc($ready) . '</div>'
            . '<div style="font-size:12px;color:' . self::INK . ';opacity:.7;margin-top:2px">približne ' . $mins . ' minút</div>'
            . '</td></tr></table>';
    }

    private function itemsTable(array $o): string
    {
        $rows = '';
        foreach ($o['items'] as $i) {
            $extras = '';
            foreach ($i['extras'] as $e) {
                $price = (int) round(((float) $e['price']) * 100);
                $extras .= '<div style="font-size:12px;color:' . self::MUTED . '">+ '
                    . $this->esc((string) $e['name'])
                    . ($price > 0 ? ' (' . Money::format($price) . ')' : '') . '</div>';
            }
            if (!empty($i['note'])) {
                $extras .= '<div style="font-size:12px;color:' . self::MUTED . ';font-style:italic">„'
                    . $this->esc((string) $i['note']) . '“</div>';
            }
            $rows .= '<tr>'
                . '<td style="padding:9px 0;border-bottom:1px solid #e6dcc8;vertical-align:top;width:40px;'
                . 'font-weight:800;color:' . self::BURGUNDY . '">' . (int) $i['quantity'] . '×</td>'
                . '<td style="padding:9px 0;border-bottom:1px solid #e6dcc8;vertical-align:top">'
                . '<strong style="font-size:15px">' . $this->esc((string) $i['name']) . '</strong>' . $extras . '</td>'
                . '<td style="padding:9px 0;border-bottom:1px solid #e6dcc8;vertical-align:top;text-align:right;'
                . 'white-space:nowrap;font-weight:700">' . Money::format((int) $i['line_cents']) . '</td>'
                . '</tr>';
        }
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px;'
            . 'border-top:2px solid ' . self::INK . '">' . $rows . '</table>';
    }

    private function totalsTable(array $o): string
    {
        $delivery = (int) $o['delivery_fee_cents'];
        $vatRows  = '';
        foreach (($o['vat'] ?? []) as $group => $v) {
            $label = $group === 'drinks' ? 'Nápoje' : 'Jedlo';
            $vatRows .= '<tr><td style="padding:2px 0;font-size:12px;color:' . self::MUTED . '">'
                . "DPH $label " . rtrim(rtrim(number_format((float) $v['rate'], 2, ',', ''), '0'), ',') . ' % '
                . '(základ ' . Money::format((int) $v['base']) . ')</td>'
                . '<td style="padding:2px 0;font-size:12px;color:' . self::MUTED . ';text-align:right">'
                . Money::format((int) $v['vat']) . '</td></tr>';
        }

        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 20px">'
            . '<tr><td style="padding:3px 0;color:' . self::MUTED . '">Medzisúčet</td>'
            . '<td style="padding:3px 0;text-align:right">' . Money::format((int) $o['subtotal_cents']) . '</td></tr>'
            . '<tr><td style="padding:3px 0;color:' . self::MUTED . '">'
            . ($o['order_type'] === 'pickup' ? 'Osobný odber' : 'Doručenie') . '</td>'
            . '<td style="padding:3px 0;text-align:right">'
            . ($delivery === 0 ? 'Zdarma' : Money::format($delivery)) . '</td></tr>'
            . $vatRows
            . '<tr><td style="padding:10px 0 0;border-top:2px solid ' . self::INK . ';font-size:19px;font-weight:800">Celkom</td>'
            . '<td style="padding:10px 0 0;border-top:2px solid ' . self::INK . ';text-align:right;font-size:19px;'
            . 'font-weight:800;color:' . self::BURGUNDY . '">' . Money::format((int) $o['total_cents']) . '</td></tr>'
            . '</table>';
    }

    private function deliveryBlock(array $o): string
    {
        if ($o['order_type'] === 'pickup') {
            return $this->infoRow('Osobný odber', $this->esc($this->shopAddress()))
                . ($o['pickup_time'] ? $this->infoRow('Čas odberu', $this->esc((string) $o['pickup_time'])) : '');
        }
        return $this->infoRow('Doručenie na adresu', $this->esc($this->customerAddress($o)));
    }

    private function paymentBlock(array $o): string
    {
        $label = $o['payment_method'] === 'card' ? 'Platobná karta' : 'Hotovosť pri prevzatí';
        $state = $o['payment_status'] === 'paid' ? ' — zaplatené' : '';
        return $this->infoRow('Platba', $this->esc($label . $state));
    }

    private function infoRow(string $label, string $valueHtml): string
    {
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px">'
            . '<tr><td style="font-size:10px;letter-spacing:2px;font-weight:700;color:' . self::MUTED
            . ';text-transform:uppercase;padding-bottom:2px">' . $this->esc($label) . '</td></tr>'
            . '<tr><td style="font-size:15px">' . $valueHtml . '</td></tr></table>';
    }

    private function paragraph(string $html, string $color = self::INK, int $size = 15): string
    {
        return '<p style="margin:0 0 16px;font-size:' . $size . 'px;line-height:1.6;color:' . $color . '">'
            . $html . '</p>';
    }

    private function buttonRow(string $label, string $url): string
    {
        return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px">'
            . '<tr><td style="background:' . self::BURGUNDY . ';border-radius:999px">'
            . '<a href="' . $this->esc($url) . '" style="display:inline-block;padding:14px 26px;color:' . self::CREAM
            . ';text-decoration:none;font-weight:800;font-size:13px;letter-spacing:1.5px;text-transform:uppercase">'
            . $this->esc($label) . '</a></td></tr></table>';
    }

    /* ---------------- textové verzie ---------------- */

    private function textReceipt(array $o, string $intro): string
    {
        $lines   = [];
        $lines[] = 'ENZO — SMASH BURGERS & PIZZA';
        $lines[] = str_repeat('=', 44);
        $lines[] = $intro;
        $lines[] = '';
        $lines[] = 'Objednávka: #' . $o['order_number'];
        $lines[] = 'Dátum:      ' . date('d.m.Y H:i', strtotime((string) $o['created_at']));
        $lines[] = 'Typ:        ' . ($o['order_type'] === 'pickup' ? 'Osobný odber' : 'Doručenie');
        $lines[] = 'Platba:     ' . ($o['payment_method'] === 'card' ? 'Platobná karta' : 'Hotovosť pri prevzatí');
        $lines[] = '';
        $lines[] = $this->textItems($o);
        $lines[] = str_repeat('-', 44);
        $lines[] = sprintf('%-30s %13s', 'Medzisúčet', Money::plain((int) $o['subtotal_cents']));
        $lines[] = sprintf(
            '%-30s %13s',
            $o['order_type'] === 'pickup' ? 'Osobný odber' : 'Doručenie',
            Money::plain((int) $o['delivery_fee_cents'])
        );
        $lines[] = str_repeat('=', 44);
        $lines[] = sprintf('%-30s %13s', 'CELKOM', Money::plain((int) $o['total_cents']));
        $lines[] = '';
        $lines[] = $o['order_type'] === 'pickup'
            ? 'Odber: ' . $this->shopAddress()
            : 'Doručenie: ' . $this->customerAddress($o);
        $lines[] = '';
        $lines[] = Settings::get('company_name') . ' · IČO ' . Settings::get('company_ico')
            . ' · DIČ ' . Settings::get('company_dic');
        return implode("\n", $lines);
    }

    private function textItems(array $o): string
    {
        $out = [];
        foreach ($o['items'] as $i) {
            $out[] = sprintf(
                '%-30s %13s',
                mb_substr((int) $i['quantity'] . '× ' . $i['name'], 0, 30),
                Money::plain((int) $i['line_cents'])
            );
            foreach ($i['extras'] as $e) {
                $out[] = '   + ' . $e['name'];
            }
            if (!empty($i['note'])) {
                $out[] = '   „' . $i['note'] . '“';
            }
        }
        return implode("\n", $out) . "\n";
    }

    /* ---------------- pomocné ---------------- */

    public function orderLink(array $o): string
    {
        return rtrim($this->appUrl, '/') . '/objednavka/?c=' . rawurlencode((string) $o['order_number'])
            . '&t=' . rawurlencode((string) $o['access_token']);
    }

    private function shopAddress(): string
    {
        return Settings::get('shop_street') . ', ' . Settings::get('shop_postal_code')
            . ' ' . Settings::get('shop_city');
    }

    private function customerAddress(array $o): string
    {
        return trim(($o['street'] ?? '') . ' ' . ($o['house_number'] ?? ''))
            . ', ' . ($o['postal_code'] ?? '') . ' ' . ($o['city'] ?? '');
    }

    private function esc(string $s): string
    {
        return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }
}
