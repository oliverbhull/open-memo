const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('onboarding uses the native Input Monitoring permission probe', () => {
  const main = read('electron/main/index.ts');
  const native = read('sidecars/dictation/src/main.rs');
  assert.match(main, /checkInputMonitoringPermission\(false\)/);
  assert.match(main, /checkInputMonitoringPermission\(true\)/);
  assert.doesNotMatch(main, /check-input-monitoring[\s\S]{0,500}return app\.isReady\(\)/);
  assert.match(native, /--check-input-monitoring/);
  assert.match(native, /--request-input-monitoring/);
});

test('saving the user name merges it into speech vocabulary', () => {
  const main = read('electron/main/index.ts');
  assert.match(main, /settings\.vocabWords = \[\.\.\.settings\.vocabWords, normalizedName\]/);
  assert.match(main, /memoSttService\?\.updateVocabulary\(\)/);
});

test('Try Memo requires real readiness and successful paste delivery', () => {
  const onboarding = read('electron/renderer/src/components/Onboarding.tsx');
  const service = read('electron/main/services/MemoSttService.ts');
  const main = read('electron/main/index.ts');
  assert.match(onboarding, /readiness\?\.ready/);
  assert.match(onboarding, /delivery === 'pasted'/);
  assert.match(onboarding, /Microphone is working/);
  assert.doesNotMatch(onboarding, /Continue Anyway/);
  assert.match(service, /this\.readiness\.hotkey && this\.readiness\.microphone && this\.readiness\.model/);
  assert.match(main, /mainWindow\.webContents\.paste\(\)/);
});
