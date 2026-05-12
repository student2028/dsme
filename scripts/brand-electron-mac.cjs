/**
 * macOS dev: Dock / tooltip shows CFBundleDisplayName from Electron.app.
 * Unpackaged runs use node_modules/electron/dist/Electron.app → defaults to "Electron".
 * Patch plist once per install so hover shows "dsme" during vite/electron dev.
 */
const { execSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

const DISPLAY = 'dsme';

if (process.platform !== 'darwin') process.exit(0);

const plist = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'Info.plist'
);

if (!existsSync(plist)) {
  console.warn('[dsme] brand-electron-mac: skip (Electron.app not found — run npm install)');
  process.exit(0);
}

try {
  execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ${DISPLAY}" "${plist}"`, {
    stdio: 'inherit',
  });
  execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName ${DISPLAY}" "${plist}"`, {
    stdio: 'inherit',
  });
} catch {
  process.exit(1);
}

console.log(`[dsme] macOS dev Electron.app → CFBundleDisplayName "${DISPLAY}" (Dock hover)`);
