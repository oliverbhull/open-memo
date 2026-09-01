import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const workflow = fs.readFileSync(
  path.join(process.cwd(), '.github', 'workflows', 'mirror-firmware-release.yml'),
  'utf8',
);

test('firmware mirror is event driven with a daily reconciliation fallback', () => {
  assert.match(workflow, /repository_dispatch:\s*\n\s+types: \[firmware-release-published\]/);
  assert.match(workflow, /cron: "17 9 \* \* \*"/);
  assert.doesNotMatch(workflow, /\*\/15 \* \* \* \*/);
  assert.match(workflow, /github\.event\.client_payload\.release_tag \|\| inputs\.release_tag/);
});

test('an event-requested firmware tag is validated and downloaded exactly', () => {
  assert.match(workflow, /REQUESTED_RELEASE_TAG/);
  assert.match(workflow, /releases\/tags\/\$release_tag/);
  assert.match(workflow, /gh release download "\$release_tag"/);
});
