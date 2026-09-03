import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const usbTranscripts = fs.readFileSync(
  path.join(root, 'electron', 'shared', 'usb-transcripts.ts'),
  'utf8',
);
const app = fs.readFileSync(path.join(root, 'electron', 'renderer', 'src', 'App.tsx'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main', 'index.ts'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'sidecars', 'device-sync', 'device_sync.py'), 'utf8');

test('device recording audio uses the entry-owned filename contract', () => {
  assert.match(usbTranscripts, /fileName: `memo-device-\$\{row\.source_sha256\.toLowerCase\(\)\}\.wav`/);
});

test('archive reconciliation records success only after the feed save succeeds', () => {
  const save = app.indexOf('const entry = await addEntry(transcription)');
  const remembered = app.indexOf('importedUsbIdsRef.current.add(transcription.id)', save);
  assert.ok(save >= 0 && remembered > save);
  assert.match(app, /if \(usbImportPromiseRef\.current\) return usbImportPromiseRef\.current/);
  assert.match(app, /status\.state === 'complete'[\s\S]*?importUsbTranscripts\(\)[\s\S]*?Memo sync complete/);
  assert.doesNotMatch(main, /deviceSyncService\.on\('transcription'/);
});

test('BLE command reads allow bounded CoreBluetooth scheduling delay', () => {
  assert.match(worker, /port\.timeout = 3\.0/);
});
