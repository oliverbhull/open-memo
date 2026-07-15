# Changelog

All notable changes to Open Memo will be documented in this file.

This project follows semantic versioning once public releases begin.

## Unreleased

- Remove unfinished sync, legacy BLE, audio-storage, and unused renderer subsystems.
- Consolidate settings and typed IPC around a single persisted store and narrow preload bridges.
- Harden IndexedDB, export, window sandboxing, content security policy, scripts, and release signing checks.
- Reduce production dependencies to `electron-store`, update the toolchain, and add type-check/test gates.

## 0.1.2 - 2026-07-15

- Prevent release verification from mutating the signed app bundle.

## 0.1.1 - 2026-07-15

- Ship the Nemotron-only ASR backend.

## 0.1.0 - 2026-07-15

- Prepare the repository for the open-source `oliverbhull/open-memo` launch.
- Add GitHub Actions CI and tag-driven macOS release workflow.
- Use the published `memo-stt` Cargo package for reproducible desktop builds.
