<?php
declare(strict_types=1);

require __DIR__ . '/_layout.php';

if (Auth::check()) {
    AuditLog::write('logout', 'user', (int) (Auth::user()['id'] ?? 0));
}
Auth::logout();
redirect('index.php');
