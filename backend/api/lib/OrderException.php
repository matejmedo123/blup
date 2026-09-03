<?php
declare(strict_types=1);

/**
 * Chyba doménovej logiky objednávok, ktorá nesie aj kód pre frontend.
 *
 * Vďaka nej môže logika v `lib/` odmietnuť operáciu bez toho, aby vedela
 * čokoľvek o HTTP — endpoint ju odchytí a preloží na odpoveď.
 */
final class OrderException extends RuntimeException
{
    /** @var array<string,string> */
    private array $fields;

    private string $code_;

    /** @param array<string,string> $fields */
    public function __construct(string $code, string $message, array $fields = [])
    {
        parent::__construct($message);
        $this->code_  = $code;
        $this->fields = $fields;
    }

    public function errorCode(): string
    {
        return $this->code_;
    }

    /** @return array<string,string> */
    public function fields(): array
    {
        return $this->fields;
    }

    /** Odošle sa klientovi aj s kódom a správnym HTTP číslom. */
    public function respond(): never
    {
        Response::failCode($this->code_, $this->getMessage(), $this->fields);
    }
}
