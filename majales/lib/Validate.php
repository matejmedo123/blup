<?php
declare(strict_types=1);

/**
 * Kontrola vstupov z formulárov. Chyby sú po slovensky a vracajú sa
 * po poliach, aby ich admin vedel ukázať pri konkrétnom políčku.
 */
final class Validate
{
    /** @var array<string,string> */
    private array $errors = [];

    /** @var array<string,mixed> */
    private array $data;

    /** @param array<string,mixed> $data */
    public function __construct(array $data)
    {
        $this->data = $data;
    }

    public function raw(string $field): string
    {
        $v = $this->data[$field] ?? '';
        return is_scalar($v) ? (string) $v : '';
    }

    public function text(string $field, string $label, bool $required = false, int $max = 255): string
    {
        $value = trim($this->raw($field));
        // Riadiace znaky sem nepatria — vedia rozbiť výstup aj e-maily.
        $value = (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value);

        if ($required && $value === '') {
            $this->errors[$field] = $label . ' treba vyplniť.';
            return '';
        }
        if ($value !== '' && mb_strlen($value) > $max) {
            $this->errors[$field] = $label . ' je pridlhý (max. ' . $max . ' znakov).';
            return mb_substr($value, 0, $max);
        }
        return $value;
    }

    public function multiline(string $field, string $label, bool $required = false, int $max = 20000): string
    {
        $value = trim($this->raw($field));
        $value = str_replace("\r\n", "\n", $value);
        $value = (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value);

        if ($required && $value === '') {
            $this->errors[$field] = $label . ' treba vyplniť.';
            return '';
        }
        if (mb_strlen($value) > $max) {
            $this->errors[$field] = $label . ' je pridlhý (max. ' . $max . ' znakov).';
            return mb_substr($value, 0, $max);
        }
        return $value;
    }

    public function email(string $field, string $label, bool $required = true): string
    {
        $value = strtolower(trim($this->raw($field)));
        if ($value === '') {
            if ($required) {
                $this->errors[$field] = $label . ' treba vyplniť.';
            }
            return '';
        }
        if (!filter_var($value, FILTER_VALIDATE_EMAIL) || mb_strlen($value) > 190) {
            $this->errors[$field] = 'Zadaj e-mail v tvare meno@domena.sk.';
            return '';
        }
        return $value;
    }

    public function url(string $field, string $label, bool $required = false): string
    {
        $value = trim($this->raw($field));
        if ($value === '') {
            if ($required) {
                $this->errors[$field] = $label . ' treba vyplniť.';
            }
            return '';
        }
        if (Html::safeUrl($value) === '' || mb_strlen($value) > 255) {
            $this->errors[$field] = $label . ' musí byť odkaz začínajúci https://.';
            return '';
        }
        return $value;
    }

    public function int(string $field, string $label, ?int $min = null, ?int $max = null, int $default = 0): int
    {
        $raw = trim($this->raw($field));
        if ($raw === '') {
            return $default;
        }
        if (!preg_match('/^-?\d+$/', $raw)) {
            $this->errors[$field] = $label . ' musí byť číslo.';
            return $default;
        }
        $value = (int) $raw;
        if ($min !== null && $value < $min) {
            $this->errors[$field] = $label . ' nesmie byť menej ako ' . $min . '.';
            return $default;
        }
        if ($max !== null && $value > $max) {
            $this->errors[$field] = $label . ' nesmie byť viac ako ' . $max . '.';
            return $default;
        }
        return $value;
    }

    /** Cena z formulára („12,50") na celé centy. Prázdne pole = null. */
    public function priceCents(string $field, string $label): ?int
    {
        $raw = trim($this->raw($field));
        if ($raw === '') {
            return null;
        }
        $raw = str_replace([' ', "\u{00A0}", ','], ['', '', '.'], $raw);
        if (!preg_match('/^\d+(\.\d{1,2})?$/', $raw)) {
            $this->errors[$field] = $label . ' zadaj v tvare 24,90.';
            return null;
        }
        return (int) round((float) $raw * 100);
    }

    public function bool(string $field): int
    {
        $v = $this->data[$field] ?? null;
        return in_array((string) $v, ['1', 'on', 'true', 'ano'], true) ? 1 : 0;
    }

    /** Dátum a čas z políčka `datetime-local`. */
    public function dateTime(string $field, string $label, bool $required = false): string
    {
        $raw = trim($this->raw($field));
        if ($raw === '') {
            if ($required) {
                $this->errors[$field] = $label . ' treba vyplniť.';
            }
            return '';
        }
        $raw = str_replace('T', ' ', $raw);
        $ts  = strtotime($raw);
        if ($ts === false) {
            $this->errors[$field] = $label . ' nie je platný dátum.';
            return '';
        }
        return date('Y-m-d H:i:s', $ts);
    }

    /** Adresa v menu z názvu — bez diakritiky, malé písmená, pomlčky. */
    public static function slug(string $text): string
    {
        $map = [
            'á'=>'a','ä'=>'a','č'=>'c','ď'=>'d','é'=>'e','í'=>'i','ĺ'=>'l','ľ'=>'l',
            'ň'=>'n','ó'=>'o','ô'=>'o','ŕ'=>'r','š'=>'s','ť'=>'t','ú'=>'u','ý'=>'y',
            'ž'=>'z','ě'=>'e','ř'=>'r','ů'=>'u','ö'=>'o','ü'=>'u','ß'=>'ss',
        ];
        $s = mb_strtolower(trim($text));
        $s = strtr($s, $map);
        $s = (string) preg_replace('/[^a-z0-9]+/u', '-', $s);
        $s = trim($s, '-');
        return $s !== '' ? mb_substr($s, 0, 120) : 'polozka';
    }

    public function fail(string $field, string $message): void
    {
        $this->errors[$field] = $message;
    }

    public function ok(): bool
    {
        return $this->errors === [];
    }

    /** @return array<string,string> */
    public function errors(): array
    {
        return $this->errors;
    }

    public function firstError(): string
    {
        return $this->errors === [] ? '' : (string) reset($this->errors);
    }
}
