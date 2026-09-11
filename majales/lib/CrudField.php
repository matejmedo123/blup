<?php
declare(strict_types=1);

/** Jedno políčko v admin formulári. */
final class CrudField
{
    public function __construct(
        public readonly string $name,
        public readonly string $label,
        public readonly string $type = 'text',
        public readonly bool $required = false,
        public readonly string $hint = '',
        public readonly int $max = 255,
        /** @var list<string> pre typ `select` */
        public readonly array $options = [],
        public readonly bool $inList = false,
    ) {
    }
}
