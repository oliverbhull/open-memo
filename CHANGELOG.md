# Changelog

All notable changes to Open Memo will be documented in this file.

This project follows semantic versioning once public releases begin.

## Unreleased

- Remove unfinished sync, legacy BLE state, and unused renderer subsystems.
- Consolidate settings and typed IPC around a single persisted store and narrow preload bridges.
- Harden IndexedDB, export, window sandboxing, content security policy, scripts, and release signing checks.
- Reduce production dependencies to `electron-store`, update the toolchain, and add type-check/test gates.
- Simplify the menu-bar tray and add direct Open Memo and Settings actions.
- Add opt-in local WAV retention with transcript-ID linking, feed playback, and deletion cleanup.
- Record application bundle identity and render native macOS icons for dictation history.
- Export active transcriptions as JSON for either a selected date-time range or the complete history.

## 0.1.2 - 2026-07-15

- Prevent release verification from mutating the signed app bundle.

## 0.1.1 - 2026-07-15

- Ship the Nemotron-only ASR backend.

## 0.1.0 - 2026-07-15

- Prepare the repository for the open-source `oliverbhull/open-memo` launch.
- Add GitHub Actions CI and tag-driven macOS release workflow.
- Use the published `memo-stt` Cargo package for reproducible desktop builds.
