import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('BLE bridge remains alive for the CoreBluetooth run loop', () => {
  const source = readFileSync(path.resolve('sidecars/ble-bridge/main.swift'), 'utf8');

  assert.match(source, /let bridge = Bridge\(\)/);
  assert.match(source, /withExtendedLifetime\(bridge\)\s*\{\s*RunLoop\.main\.run\(\)/s);
  assert.doesNotMatch(source, /_ = Bridge\(\)/);
});
