<?php
declare(strict_types=1);

/**
 * Chybové kódy, ktoré vracia API.
 *
 * Odpoveď má vždy tvar:
 *   {"ok":false,"code":"RESTAURANT_CLOSED","error":"…po slovensky…","fields":{}}
 *
 * Text je pre zákazníka, kód pre frontend — podľa neho vie zareagovať
 * (poslať človeka upraviť košík, ukázať otváracie hodiny, ponúknuť
 * platbu v hotovosti namiesto karty).
 */
final class ErrorCode
{
    public const VALIDATION_ERROR          = 'VALIDATION_ERROR';
    public const UNAUTHORIZED              = 'UNAUTHORIZED';
    public const FORBIDDEN                 = 'FORBIDDEN';
    public const NOT_FOUND                 = 'NOT_FOUND';
    public const METHOD_NOT_ALLOWED        = 'METHOD_NOT_ALLOWED';

    public const RESTAURANT_CLOSED         = 'RESTAURANT_CLOSED';
    public const ORDERS_PAUSED             = 'ORDERS_PAUSED';
    public const PRODUCT_UNAVAILABLE       = 'PRODUCT_UNAVAILABLE';
    public const INVALID_MODIFIER          = 'INVALID_MODIFIER';
    public const EMPTY_CART                = 'EMPTY_CART';
    public const MINIMUM_ORDER_NOT_REACHED = 'MINIMUM_ORDER_NOT_REACHED';
    public const OUTSIDE_DELIVERY_ZONE     = 'OUTSIDE_DELIVERY_ZONE';
    public const INVALID_COUPON            = 'INVALID_COUPON';

    public const INVALID_STATUS_TRANSITION = 'INVALID_STATUS_TRANSITION';
    public const ORDER_ALREADY_HANDLED     = 'ORDER_ALREADY_HANDLED';

    public const PAYMENT_METHOD_UNAVAILABLE = 'PAYMENT_METHOD_UNAVAILABLE';
    public const PAYMENT_FAILED            = 'PAYMENT_FAILED';

    public const DUPLICATE_REQUEST         = 'DUPLICATE_REQUEST';
    public const IDEMPOTENCY_CONFLICT      = 'IDEMPOTENCY_CONFLICT';
    public const RATE_LIMITED              = 'RATE_LIMITED';
    public const SESSION_EXPIRED           = 'SESSION_EXPIRED';
    public const SERVER_ERROR              = 'SERVER_ERROR';

    /** Aké HTTP číslo sa ku kódu hodí. */
    public static function httpStatus(string $code): int
    {
        return match ($code) {
            self::UNAUTHORIZED, self::SESSION_EXPIRED => 401,
            self::FORBIDDEN                           => 403,
            self::NOT_FOUND                           => 404,
            self::METHOD_NOT_ALLOWED                  => 405,
            self::ORDER_ALREADY_HANDLED,
            self::INVALID_STATUS_TRANSITION,
            self::IDEMPOTENCY_CONFLICT,
            self::PRODUCT_UNAVAILABLE                 => 409,
            self::RESTAURANT_CLOSED, self::ORDERS_PAUSED => 423,
            self::RATE_LIMITED                        => 429,
            self::SERVER_ERROR                        => 500,
            default                                   => 422,
        };
    }
}
