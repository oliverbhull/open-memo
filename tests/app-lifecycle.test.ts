import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainSource = readFileSync('electron/main/index.ts', 'utf8');
const traySource = readFileSync('electron/main/services/TrayService.ts', 'utf8');

test('closing the Memo window uses the standard macOS window lifecycle', () => {
  assert.doesNotMatch(mainSource, /mainWindow\.on\('close',[\s\S]*?event\.preventDefault\(\)/);
  assert.doesNotMatch(mainSource, /app\.dock\?\.hide\(\)/);
});

test('all explicit open actions use the shared activating window path', () => {
  assert.match(
    mainSource,
    /function openMainWindow\(\): void[\s\S]*?createWindow\(\)[\s\S]*?app\.focus\(\{ steal: true \}\)[\s\S]*?mainWindow\.show\(\)/,
  );
  assert.match(traySource, /function openMainWindow\(\)[\s\S]*?openMainWindowHandler\?\.\(\)/);
  assert.match(mainSource, /setOpenMainWindowHandler\(openMainWindow\)/);
});
