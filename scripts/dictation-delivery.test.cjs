const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

test('delivery subscriptions survive independent unsubscribe and do not replace history listeners', () => {
  const ipcRenderer = new EventEmitter();
  let api;
  const source = transformSync(fs.readFileSync('electron/preload/index.ts', 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022',
  }).code;
  vm.runInNewContext(source, {
    process: { platform: 'win32' },
    require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } } };
    },
  });
  const history = [];
  const first = [];
  const second = [];
  api.onTranscription(value => history.push(value));
  const unsubscribeFirst = api.onDictationDelivery(value => first.push(value));
  const unsubscribeSecond = api.onDictationDelivery(value => second.push(value));
  const delivered = { text: 'Hello ThinkPad.', delivery: 'pasted' };
  ipcRenderer.emit('dictation:delivery', {}, delivered);
  assert.deepEqual(first, [delivered]);
  assert.deepEqual(second, [delivered]);
  assert.deepEqual(history, []);
  unsubscribeFirst();
  unsubscribeFirst();
  ipcRenderer.emit('dictation:delivery', {}, delivered);
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);
  ipcRenderer.emit('transcription:new', {}, { processedText: 'History remains subscribed.' });
  assert.equal(history.length, 1);
  unsubscribeSecond();
  assert.equal(ipcRenderer.listenerCount('dictation:delivery'), 0);
  assert.equal(ipcRenderer.listenerCount('transcription:new'), 1);
});
