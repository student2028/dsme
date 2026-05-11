/**
 * Chrome Cookie Sync for DSME
 *
 * Reads cookies from the user's Chrome browser and injects them into
 * Electron's session, so webview/BrowserWindow can access logged-in sites.
 *
 * macOS only — reads Chrome Safe Storage key from Keychain,
 * decrypts AES-128-CBC encrypted cookie values.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

const CHROME_COOKIES_PATH = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/Default/Cookies'
);

/** Get Chrome Safe Storage decryption key from macOS Keychain */
function getDecryptionKey(): Buffer {
  const password = execSync(
    'security find-generic-password -s "Chrome Safe Storage" -w',
    { encoding: 'utf8' }
  ).trim();

  // Chrome macOS: PBKDF2 with salt='saltysalt', 1003 iterations, 16-byte key
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

/** Decrypt a Chrome v10 encrypted cookie value (supports Chrome 130+ DB v24) */
function decryptValue(encrypted: Buffer, key: Buffer): string {
  if (!encrypted || encrypted.length <= 3) return '';

  const prefix = encrypted.slice(0, 3).toString('utf8');
  if (prefix !== 'v10') {
    // Not encrypted — return as-is
    return encrypted.toString('utf8');
  }

  try {
    const iv = Buffer.alloc(16, ' '); // 16 bytes of 0x20 (space)
    const data = encrypted.slice(3);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

    // Chrome 130+ (DB version >= 24): first 32 bytes are SHA-256 hash of the domain
    // The actual cookie value follows after byte 32
    if (decrypted.length > 32) {
      const afterHash = decrypted.slice(32).toString('utf8');
      // If the result after stripping hash looks like valid text, use it
      if (afterHash && /^[\x20-\x7E]/.test(afterHash)) {
        return afterHash;
      }
    }

    // Fallback: try the whole buffer as text (older Chrome versions)
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Sync Chrome cookies into an Electron session.
 * Results persist in Electron's userData — no need to call on every restart.
 *
 * @returns Number of cookies successfully imported
 */
export async function syncChromeCookies(session: Electron.Session): Promise<number> {
  if (process.platform !== 'darwin') {
    console.log('[ChromeCookies] Only macOS supported');
    return 0;
  }

  if (!fs.existsSync(CHROME_COOKIES_PATH)) {
    console.log('[ChromeCookies] Chrome cookies not found');
    return 0;
  }

  try {
    const key = getDecryptionKey();

    // Copy cookies DB to temp (Chrome locks the original file)
    const tmpDir = path.join(os.tmpdir(), 'dsme-cookies');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpDb = path.join(tmpDir, 'Cookies');
    fs.copyFileSync(CHROME_COOKIES_PATH, tmpDb);

    // Also copy journal/wal if present (for complete data)
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const src = CHROME_COOKIES_PATH + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, tmpDb + suffix);
      }
    }

    // Use JSON output from sqlite3 to avoid pipe-delimiter issues with cookie values
    const output = execSync(
      `sqlite3 -json "${tmpDb}" "SELECT host_key, name, path, is_secure, expires_utc, is_httponly, samesite, hex(encrypted_value) AS hex_value FROM cookies WHERE expires_utc > 0"`,
      { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }
    );

    // Cleanup temp files
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch {}

    let rows: any[];
    try {
      rows = JSON.parse(output);
    } catch {
      console.error('[ChromeCookies] Failed to parse sqlite3 JSON output');
      return 0;
    }

    let count = 0;
    let skipped = 0;
    const now = Date.now() / 1000;

    for (const row of rows) {
      try {
        const encrypted = Buffer.from(row.hex_value || '', 'hex');
        const value = decryptValue(encrypted, key);
        if (!value) { skipped++; continue; }

        const host: string = row.host_key;
        const secure = row.is_secure === 1;
        const domain = host.startsWith('.') ? host.slice(1) : host;
        const url = `http${secure ? 's' : ''}://${domain}${row.path}`;

        // Chrome's expires_utc: microseconds since 1601-01-01
        const expirationDate = (row.expires_utc / 1000000) - 11644473600;
        if (expirationDate < now) { skipped++; continue; } // Already expired

        // Chrome samesite: -1=unspecified, 0=none, 1=lax, 2=strict
        const sameSiteMap: Record<number, 'unspecified' | 'no_restriction' | 'lax' | 'strict'> = {
          [-1]: 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict',
        };

        await session.cookies.set({
          url,
          name: row.name,
          value,
          domain: host,
          path: row.path,
          secure,
          httpOnly: row.is_httponly === 1,
          sameSite: sameSiteMap[row.samesite] || 'unspecified',
          expirationDate,
        });

        count++;
      } catch {
        skipped++;
      }
    }

    console.log(`[ChromeCookies] Synced ${count} cookies (${skipped} skipped, ${rows.length} total)`);
    return count;
  } catch (e: any) {
    console.error('[ChromeCookies] Sync failed:', e.message);
    return 0;
  }
}
