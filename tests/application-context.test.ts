import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMO_APPLICATION_CONTEXT,
  resolveApplicationContext,
} from '../electron/main/services/applicationContext';

const previousApplication = {
  appName: 'Safari',
  windowTitle: 'Previous tab',
  bundleId: 'com.apple.Safari',
};

test('attributes a new dictation to Memo while its window is focused', () => {
  assert.deepEqual(resolveApplicationContext(previousApplication, true), MEMO_APPLICATION_CONTEXT);
});

test('preserves the detected destination while Memo is visible behind another app', () => {
  assert.equal(resolveApplicationContext(previousApplication, false), previousApplication);
});

test('preserves an unavailable destination while Memo is not focused', () => {
  assert.equal(resolveApplicationContext(undefined, false), undefined);
});
