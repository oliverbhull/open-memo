const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { buildSync } = require('esbuild');

function loadIcons() {
  const entry = path.resolve('electron/main/services/ApplicationIconService.ts');
  const js = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, define: { 'process.platform': '"darwin"' },
    external: ['electron', '../utils/logger'] }).outputFiles[0].text;
  const loaded = new Module(entry, module), original = Module._load;
  Module._load = (name, ...args) => {
    if (name === 'electron') return { app: {}, nativeImage: { createFromBuffer: buffer => ({
      isEmpty: () => buffer.toString() !== 'valid-icon',
      resize: () => ({ toDataURL: () => 'data:image/png;base64,website' }),
    }) } };
    if (name === '../utils/logger') return { logger: { debug() {}, warn() {} } };
    if (name === 'node:fs') return { existsSync: () => true };
    return original(name, ...args);
  };
  try { loaded._compile(js, entry); } finally { Module._load = original; }
  const service = new loaded.exports.ApplicationIconService();
  service.resolveRunningApplication = () => ({ appPath: '/Applications/Safari.app' });
  service.loadBundleIcon = () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,browser' });
  return service;
}

test('website icon is cached by domain and fetched without page details', async () => {
  const service = loadIcons();
  const original = global.fetch;
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://mail.google.com/favicon.ico');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    return new Response('valid-icon');
  };
  try {
    for (let i = 0; i < 2; i++) assert.equal(await service.getIconDataUrl('Safari', 'com.apple.Safari', 'mail.google.com'), 'data:image/png;base64,website');
    assert.equal(calls, 1);
  } finally { global.fetch = original; }
});

test('missing, invalid, oversized, or offline favicons fall back to browser icon', async () => {
  const original = global.fetch;
  try {
    for (const fetcher of [
      async () => new Response('', { status: 404 }),
      async () => new Response('not-an-image'),
      async () => new Response('x'.repeat(256 * 1024 + 1)),
      async () => { throw new Error('offline'); },
    ]) {
      global.fetch = fetcher;
      assert.equal(await loadIcons().getIconDataUrl('Safari', 'com.apple.Safari', 'mail.google.com'), 'data:image/png;base64,browser');
    }
  } finally { global.fetch = original; }
});

test('native apps and entries without a website use app icons without network', async () => {
  const original = global.fetch;
  global.fetch = () => { throw new Error('must not fetch'); };
  try {
    const service = loadIcons();
    assert.equal(await service.getIconDataUrl('Safari', 'com.apple.Safari'), 'data:image/png;base64,browser');
    assert.equal(await service.getIconDataUrl('TextEdit', 'com.apple.TextEdit', 'mail.google.com'), 'data:image/png;base64,browser');
    assert.deepEqual(service.enrichContext({ appName: 'Safari', windowTitle: 'Inbox', bundleId: 'com.apple.Safari', websiteDomain: 'mail.google.com' }), {
      appName: 'Safari', windowTitle: 'Inbox', bundleId: 'com.apple.Safari', websiteDomain: 'mail.google.com',
    });
  } finally { global.fetch = original; }
});


test('favicon redirects such as Gmail CDN are followed, with ICO support', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async url => {
    calls.push(url);
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://ssl.gstatic.com/gmail.ico' } });
    return new Response(Buffer.from([0, 0, 1, 0, 1, 0, 0, 0]));
  };
  try {
    assert.match(await loadIcons().getIconDataUrl('Safari', 'com.apple.Safari', 'mail.google.com'), /^data:image\/x-icon;base64,/);
    assert.deepEqual(calls, ['https://mail.google.com/favicon.ico', 'https://ssl.gstatic.com/gmail.ico']);
  } finally { global.fetch = original; }
});
