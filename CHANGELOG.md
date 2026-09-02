# Changelog

All notable changes to Open Memo will be documented in this file.

This project follows semantic versioning once public releases begin.

## Unreleased

## 0.8.3 - 2026-09-01

- Simplify the public repository and present Open Memo as a focused macOS dictation app.
- Improve supermicrophone BLE discovery, trusted-device selection, sync errors, and recorder audio playback.
- Update the signed macOS release workflow and publish a stable latest-version DMG download.

## 0.8.2 - 2026-09-01

- Replace bundled Nemotron with IBM Granite Speech 5.0 470M TurboCTC as the default ASR model, converted to a native Core ML INT4 package.
- Add a native Swift Granite worker, pinned reproducible conversion pipeline, legacy settings migration, and packaged INT4 verification while retaining optional Whisper.
- Restore capitalization, commas, periods, and question marks with a fail-open, locally running DistilBERT Core ML postprocessor.
- Add a direct latest-version macOS download and a more visual, consumer-friendly README.

## 0.6.0 - 2026-08-26

- Add bounded, encrypted Bluetooth recorder sync through the existing crash-safe archive, CRC verification, transcription, and exact acknowledgement pipeline.
- Establish the trusted Bluetooth recorder through a physical USB connection, prefer USB when both transports are available, and keep firmware updates USB-only.
- Bundle and verify the native macOS Bluetooth bridge while retaining USB recovery and the separate Bluetooth microphone workflow.
- Suppress punctuation-only speech artifacts, normalize pasted transcription text, and attribute dictation to Memo while its window is visible.

## 0.5.0 - 2026-08-25

- Store desktop and recorder-derived feed entries in the same local SQLite database, with a one-time fail-closed import that retains the previous IndexedDB data.

## 0.4.0 - 2026-08-22

- Add crash-safe USB recording sync with recovery after interrupted transfers.
- Add signed remote firmware updates after sync, with device, version, and post-flash verification.
- Simplify Open Memo by removing voice-command and keystroke automation.

## 0.3.0 - 2026-07-29

- Keep Nemotron bundled and selected by default while allowing users to download and switch to Whisper from Settings.
- Show Whisper availability and verified download progress, then restart only the transcription subprocess when switching models.
- Add synchronized microphone and speech-model dropdowns beneath the Settings color picker while preserving strict microphone selection.
- Simplify Settings by hiding the Bluetooth section and tightening the color-picker and audio-retention layout.
- Make the tray describe the active capture gesture and remove the duplicate Start at Login control.

## 0.2.2 - 2026-07-21

- Keep the explicitly selected microphone fixed when other audio devices connect, with no fallback to the macOS default input.
- Keep Bluetooth microphone input ready between dictations so short recordings do not lose speech while the input link starts.
- Remove media-output pausing so input selection never changes or interrupts audio output.

## 0.2.0 - 2026-07-15

- Remove unfinished sync, legacy BLE state, and unused renderer subsystems.
- Consolidate settings and typed IPC around a single persisted store and narrow preload bridges.
- Harden IndexedDB, export, window sandboxing, content security policy, scripts, and release signing checks.
- Reduce production dependencies to `electron-store`, update the toolchain, and add type-check/test gates.
- Simplify the menu-bar tray and add direct Open Memo and Settings actions.
- Add opt-in local WAV retention with transcript-ID linking, feed playback, and deletion cleanup.
- Record application bundle identity and render native macOS icons for dictation history.
- Export active transcriptions as JSON for either a selected date-time range or the complete history.
- Simplify saved-audio controls to a borderless play/pause toggle and remove feed deletion.
- List live macOS audio inputs in the tray with system-default following and explicit device selection.

## 0.1.2 - 2026-07-15

- Prevent release verification from mutating the signed app bundle.

## 0.1.1 - 2026-07-15

- Ship the Nemotron-only ASR backend.

## 0.1.0 - 2026-07-15

- Prepare the repository for the open-source `oliverbhull/open-memo` launch.
- Add GitHub Actions CI and tag-driven macOS release workflow.
- Use the published `memo-stt` Cargo package for reproducible desktop builds.
