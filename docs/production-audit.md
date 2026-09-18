# Production audit — 2026-09-11

> Historical checkpoint. The cleanup bundle, packaged LFM, signing checks, and
> delivery-time focused-window fix described as open below were implemented in
> the v0.8.11 production candidate. See `cleanup-production-candidate.md` and the
> current release workflow for the active state.

## Decision

The source has received a coordinated review and concrete reliability fixes.
**It is not ready to release the current development Cleaned experience.** LFM
runtime/model packaging and end-user installation/upgrade verification remain
open. No version bump, commit, push, tag, publication or app restart was performed.

Reviewed the dirty working tree and committed sync changes on
`codex/fix-reliable-device-sync-feed`, base `060526a` (package `0.8.10`). Three
subagents reviewed cleanup/native speech, sync/firmware ownership, and releases/
updates; follow-up passes checked renderer persistence and shutdown integration.
The coordinator reviewed delivery, settings, privacy, repository layout and tests.
The preexisting `WindowService.ts` edits were preserved.

## Fixed

| Area | Defect and resulting behavior |
| --- | --- |
| LFM source | The prompt was imported from ignored training code. It now lives in ordinary source, unchanged, with no restoration or semantic gate. |
| LFM transport | Startup, frames, vocabulary and technical output are bounded; expired output cannot win a timeout; pipe failures terminate the failed worker. |
| Native recognition | Startup failure leaked a child, and timed-out work could supply a stale FINAL to the next utterance. Failed workers are now killed/reaped and invalidated. |
| Worker ownership | Detached native/sync workers now monitor their owner. An owner-loss guard can terminate only the worker's own isolated group, without deleting the lock inode. |
| Sync races | Concurrent starts, old worker output, delayed transcription grants and failed-spawn closure can no longer corrupt replacement ownership. Lock conflicts retry. |
| Sync durability | Batch manifests are durable before completion; missing manifests on already-complete batches can be repaired. |
| Firmware | Flashing holds the same lock as sync before touching hardware; contention fails safely. Discovery paginates mixed app/firmware release history with a finite bound. |
| History | Main saves delivered text, original recognition, cleanup evidence and optional audio independently of renderer availability. A UI failure cannot delete audio belonging to an already-persisted entry. Tombstones are not reinserted. |
| Delivery | Complete delivery jobs are ordered. Icon decoration no longer invokes synchronous AppleScript before history persistence. Shutdown skips new paste/cleanup work and drains accepted output. |
| Shutdown | Quit/update waits for child stream closure and queued history. A suspended service cannot be resumed by a late sync callback; stale stream events cannot affect replacements. |
| Model services | Late Whisper downloads cannot override a newer model choice. Punctuation worker replacement and broken-pipe handling preserve fallback. |
| Updates | Download failures are observed and retryable; explicit install awaits worker shutdown. |
| Release assets | Exactly one versioned ARM64 ZIP and DMG plus a matching manifest are required; sizes, SHA512 values and legacy ZIP references are verified before upload. Successful CI must be a main-branch push run. |
| Privacy | Malformed transcription payloads are not printed in production error logs. Development comparison logging remains available as requested. |
| Dependencies | `js-yaml` is explicit and locked at 4.3.2; transitive Joi is updated to 18.2.9. The final lockfile audit reported zero known vulnerabilities. |

## Repository organization

The unused `CleanupWorkerClient` and its experiment tests moved out of application
services into `experiments/shared/`. Maintained tests run through `npm test` and
`npm run check`; historical experiments run separately through
`npm run test:experiments`. Historical cleanup documents are visibly labeled and
link to current guidance. See the [repository map](README.md) and
[development guide](development.md).

Ignored weights, private replays, local handoffs, old local-only tests, generated
builds and credentials were not staged or deleted. This is an uncommitted review
tree, not a claim of a clean Git status. Intended new source files must be included
in any later commit; pushing the old HEAD cannot ship these fixes.

## Validation and its limits

Validation uses a separate temporary snapshot of tracked plus intended untracked
source, excluding ignored assets and existing `node_modules`. `npm ci` installs
from the updated lockfile. It is a source build, not an installed-app test.

| Check | Result |
| --- | --- |
| Both TypeScript configurations | Passed |
| Maintained Node tests | 44 passed; 1 optional live-model test skipped |
| Python completion/ownership/durability tests | 5 passed; source-only worker self-test passed |
| Rust dictation suite | 5 passed; 1 live foreground-app test ignored |
| Historical experiments | 9 Node + 41 Python passed; 1 optional live-model test skipped |
| Isolated `npm ci` | Passed; no developer assets copied |
| Isolated main/preload/renderer builds | Passed |
| Dependency audit | Zero known vulnerabilities reported for the lockfile |
| Whitespace and Rust formatting | Passed |

Tests include real temporary SQLite reopen/import, real subprocess/flock
ownership checks, signed synthetic firmware fixtures, corrupt/missing release
artifacts, delayed worker output and shutdown stream-drain cases. Native Objective-C
macro `cargo-clippy` cfg warnings remain; compilation/tests succeed.

Read-only GitHub inspection found v0.8.10's public manifest and ZIP/DMG asset
metadata; release run `33715109835` succeeded. Manifest sizes agreed with asset
metadata. That inspection did not download/hash the binaries, install the app or
perform an upgrade, and does not validate this uncommitted tree.

## Release blockers and follow-up

1. **LFM distribution is unresolved.** Packaged code still disables Cleaned and
   bundles the older punctuation path. Establish base/adapter provenance and
   redistribution rights, pinned runtime/model checksums, offline initialization,
   native signing and a portable provisioning/build path. Do not remove the
   packaged gate merely to make the option appear enabled.
2. **Development recognition still depends on local assets.** `npm run dev` uses
   the contextual Granite prototype and machine-specific setup. An isolated source
   build does not prove that command works on a fresh machine. CI's Conomo fixture
   verifies packaging shape, not recognition.
3. **End-user validation is outstanding.** Test a signed download in Applications
   on a supported clean machine: permissions, both writing modes, offline use,
   history, device sync, relaunch and a real previous-version automatic upgrade
   with interrupted download/install recovery. Hardware flashing was not tested.
4. **Quality is not established by transport tests.** Run locked audio-grounded
   evaluation of recognition and cleanup separately, including names, negation,
   corrections, amounts, email, questions and long speech; measure stop-to-paste
   latency. Preserve the single-model, simple-prompt user decision.

Known operational limits: old-version orphan workers already running were not
terminated and cannot acquire new watchdog behavior until relaunched. Destination
checks identify apps, not fields/tabs within one app. Native recognition timeout
now fails safely and requires restart rather than reusing an expired worker.
An install failure after shutdown leaves the app requiring the restart described
in its error dialog. A database failure after audio storage can leave an orphan
WAV; it is retained rather than risking data loss. No release approval is implied.
