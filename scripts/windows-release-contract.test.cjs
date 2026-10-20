const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const yaml = require('js-yaml');
const pkg = require('../package.json');
const windows = require('../config/electron-builder.windows.cjs');

test('Windows packaging cannot replace the Mac resource list or download URL', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  assert.ok(readme.includes('https://github.com/oliverbhull/open-memo/releases/latest/download/Open-Memo-latest-arm64.dmg'));
  assert.ok(readme.includes('https://github.com/oliverbhull/open-memo/releases/download/windows-latest/Open-Memo-latest-windows-x64-setup.exe'));
  assert.ok(readme.includes('<p align="left">'));
  assert.ok(pkg.build.extraResources.some(resource => resource.to === 'conomo'));
  assert.ok(!pkg.build.extraResources.some(resource => resource.to === 'nemotron'));
  assert.deepEqual(windows.extraResources.map(resource => resource.to), ['app-icon.ico', 'dictation', 'whisper', 'nemotron', 'pnc']);
  assert.equal(windows.afterPack, null);
  assert.ok(windows.extraResources.find(resource => resource.to === 'whisper').filter.includes('ggml-base.en-q5_1.bin'));
});
test('Windows publication is explicit, signed, and separate from the Mac latest pointer', () => {
  const source = fs.readFileSync('.github/workflows/windows-release.yml', 'utf8');
  const workflow = yaml.load(source);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /MEMO_REQUIRE_WINDOWS_SIGNING/);
  assert.match(source, /WIN_CSC_LINK/);
  assert.match(source, /windows-v\$version/);
  assert.match(source, /git\/refs\/tags\/windows-latest/);
  assert.equal((source.match(/'create'.*'--latest=false'/g) || []).length, 2);
  assert.doesNotMatch(source, /latest-mac\.yml|Open-Memo-latest-arm64\.dmg/);
});
