import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('an update restart cleans up services before quitting', () => {
  const source = readFileSync('electron/main/index.ts', 'utf8');

  assert.match(
    source,
    /autoUpdater\.on\('before-quit-for-update',[\s\S]*?isQuitting = true;[\s\S]*?cleanupMemoStt\(\);/,
  );
});
