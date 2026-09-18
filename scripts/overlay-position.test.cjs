const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSync } = require('esbuild');
const vm = require('node:vm');

const compiled = buildSync({
  entryPoints: ['electron/main/services/overlayPosition.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text;
const moduleUnderTest = { exports: {} };
vm.runInNewContext(compiled, { module: moduleUnderTest, exports: moduleUnderTest.exports });
const { overlayBounds } = moduleUnderTest.exports;

test('hidden Dock keeps the overlay at the display bottom', () => {
  const bounds = { x: 0, y: 0, width: 1512, height: 982 };
  const workArea = { x: 0, y: 25, width: 1512, height: 957 };
  assert.deepEqual(
    { ...overlayBounds(200, 48, bounds, workArea, 5) },
    { width: 200, height: 48, x: 656, y: 929 },
  );
});

test('visible bottom Dock raises the overlay above the usable-area edge', () => {
  const bounds = { x: 0, y: 0, width: 1512, height: 982 };
  const workArea = { x: 0, y: 25, width: 1512, height: 887 };
  assert.deepEqual(
    { ...overlayBounds(200, 48, bounds, workArea, 5) },
    { width: 200, height: 48, x: 656, y: 859 },
  );
});

test('side Dock does not unnecessarily lift the overlay', () => {
  const bounds = { x: -1920, y: 0, width: 1920, height: 1080 };
  const workArea = { x: -1840, y: 25, width: 1840, height: 1055 };
  assert.equal(overlayBounds(200, 48, bounds, workArea, 5).y, 1027);
});
