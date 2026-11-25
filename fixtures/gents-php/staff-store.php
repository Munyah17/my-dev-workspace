<?php

declare(strict_types=1);

function savedStaff(string $directory): string
{
    $file = $directory . '/staff.txt';
    return is_file($file) ? trim((string) file_get_contents($file)) : '';
}

function saveStaff(string $directory, string $name): bool
{
    $temporary = tempnam($directory, 'staff-');
    if ($temporary === false) {
        return false;
    }
    try {
        return file_put_contents($temporary, $name, LOCK_EX) === strlen($name)
            && rename($temporary, $directory . '/staff.txt');
    } finally {
        if (is_file($temporary)) {
            unlink($temporary);
        }
    }
}
