<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
Auth::logout();
header('Location: index.php');
