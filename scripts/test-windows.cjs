const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const root = path.resolve(__dirname, '..');
process.chdir(root);
// cmd.exe does not expand globs; pass each test file explicitly.
const tests = fs.readdirSync('scripts').filter(name => name.endsWith('.test.cjs')).sort()
  .map(name => path.join('scripts', name));
run(process.execPath, ['--test', ...tests]);
const python = process.env.MEMO_TEST_PYTHON || 'python';
for (const args of [
  ['scripts/python/test_cleanup_completion.py'],
  ['scripts/python/test_device_sync_lifecycle.py'],
  ['scripts/python/transcript-cleanup-worker.py', '--self-test'],
]) run(python, args);
