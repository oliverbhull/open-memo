const assert = require('node:assert/strict');
const test = require('node:test');
const beforePack = require('./beforePack.cjs');

test('thin update excludes only persistent model packs', async t => {
  const previous = process.env.MEMO_THIN_UPDATE;
  t.after(() => {
    if (previous === undefined) delete process.env.MEMO_THIN_UPDATE;
    else process.env.MEMO_THIN_UPDATE = previous;
  });
  process.env.MEMO_THIN_UPDATE = '1';
  const config = { extraResources: [
    { to: 'dictation' }, { to: 'conomo' }, { to: 'pnc' }, { to: 'cleanup' }, { to: 'device-sync' },
  ] };
  await beforePack({ packager: { config } });
  assert.deepEqual(config.extraResources.map(resource => resource.to), ['dictation', 'device-sync']);
});
