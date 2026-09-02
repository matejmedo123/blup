<?php
declare(strict_types=1);

/** Validácia objednávky na serveri — klientskej sa nedá veriť. */
final class Validate
{
    private const EMAIL_RE  = '/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i';
    private const PHONE_RE  = '/^(\+4\d{2}|0)[\s.\/-]?\d{2,3}([\s.\/-]?\d{2,3}){2,3}$/';
    private const POSTAL_RE = '/^\d{3}\s?\d{2}$/';

    /**
     * @param array<string,mixed> $c
     * @return array<string,string> pole chýb (prázdne = v poriadku)
     */
    public static function customer(array $c, string $orderType, bool $terms): array
    {
        $e = [];
        $get = static fn (string $k): string => trim((string) ($c[$k] ?? ''));

        if ($get('firstName') === '') {
            $e['firstName'] = 'Zadajte meno.';
        } elseif (mb_strlen($get('firstName')) < 2) {
            $e['firstName'] = 'Meno musí mať aspoň 2 znaky.';
        }

        if ($get('lastName') === '') {
            $e['lastName'] = 'Zadajte priezvisko.';
        } elseif (mb_strlen($get('lastName')) < 2) {
            $e['lastName'] = 'Priezvisko musí mať aspoň 2 znaky.';
        }

        if ($get('phone') === '') {
            $e['phone'] = 'Zadajte telefónne číslo.';
        } elseif (!preg_match(self::PHONE_RE, $get('phone'))) {
            $e['phone'] = 'Zadajte platné číslo, napr. 0948 238 346.';
        }

        if ($get('email') === '') {
            $e['email'] = 'Zadajte e-mail.';
        } elseif (!preg_match(self::EMAIL_RE, $get('email'))) {
            $e['email'] = 'Zadajte platnú e-mailovú adresu.';
        }

        if ($orderType === 'pickup') {
            if ($get('pickupTime') === '') {
                $e['pickupTime'] = 'Vyberte čas odberu.';
            }
        } else {
            if ($get('street') === '') {
                $e['street'] = 'Zadajte ulicu.';
            }
            if ($get('houseNumber') === '') {
                $e['houseNumber'] = 'Zadajte číslo domu.';
            }
            if ($get('city') === '') {
                $e['city'] = 'Zadajte mesto alebo obec.';
            }
            if ($get('postalCode') === '') {
                $e['postalCode'] = 'Zadajte PSČ.';
            } elseif (!preg_match(self::POSTAL_RE, $get('postalCode'))) {
                $e['postalCode'] = 'PSČ musí mať 5 číslic, napr. 956 13.';
            }
        }

        if (!$terms) {
            $e['terms'] = 'Pre pokračovanie musíte súhlasiť s obchodnými podmienkami.';
        }

        return $e;
    }

    public static function clean(mixed $value, int $max = 255): string
    {
        $s = is_scalar($value) ? (string) $value : '';
        $s = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $s) ?? '';
        return mb_substr(trim($s), 0, $max);
    }
}
