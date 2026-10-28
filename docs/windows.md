# Windows distribution

Target: Windows 11 x64. Local acceptance hardware: ThinkPad T490s, Intel
Core i7-8665U, Intel UHD 620, 8 GB RAM. Windows ARM is not a supported target.
The bundled CPU engines require x86-64-v3: AVX2, FMA, F16C and BMI2. Windows 11
alone does not guarantee those features; some Pentium/Celeron CPUs do not qualify.
English dictation is the current model scope.

## What the installer includes

- Resident, CPU-only Nemotron streaming, selected on a fresh install.
- Resident local punctuation/capitalization with an independent Python runtime.
- Whisper Base English q5_1 and its resident worker as automatic failure fallback
  and an explicit Settings choice. A saved Base preference stays selected.
- Recorder, Windows app/title capture, executable/package icons, clipboard
  delivery, local history, native caption buttons, and dark Windows header.
- Required runtime DLLs and third-party notices. Users do not install Python,
  Visual Studio, GPU drivers, or separate models.

Hold Right Ctrl to dictate; release to insert text. Right Ctrl + Left Shift locks
recording until pressed again. Shortcuts are editable. Most PC Fn keys are handled
by keyboard firmware; F1–F12 are distinct, capturable keys.

Windows As spoken adds punctuation/capitalization without generative rewriting.
The existing Cleaned worker and its model pack use MLX and are Mac-only. Do not
offer or download that package on Windows. A future Windows cleanup backend needs
its own compatible checkpoint/runtime and latency, memory, and text-quality checks;
acceptable performance on an 8 GB ThinkPad has not been demonstrated.

Memo recorder/Bluetooth sync, browser URL/reply capture, and automatic updates are
not currently supported on Windows. Browser window titles and application icons
are supported. Elevated/protected targets can reject normal-user input injection;
the clipboard remains available. Installing a newer Windows version preserves
settings and history.

## Platform boundaries

The Windows builder config explicitly replaces the Mac resource list and Mac
afterPack hook. Windows includes only dictation, Base, Nemotron, and PnC.
windowsRuntime.ts selects these resources only in Windows launch paths.
Native Windows foreground APIs are behind cfg(windows). Mac still uses Conomo;
its build scripts, signing/notarization, release workflow, download URL, and updater
metadata are unchanged.

Shared renderer, delivery events, history service, and timing plumbing also changed.
These are shared bug fixes; not every edit is Windows-only. SQLite uses Node's
native implementation only on Windows; Mac retains its CLI. The new header,
scrollbar style, and reduced icon sizes apply only to Windows. Windows PnC uses
Edge; Mac retains its current worker, timeout and startup behavior.
Tests explicitly simulate both platforms. Real Mac CI/build verification is still
required before merge; it cannot be replaced by tests on this ThinkPad.

## Reproducible build

Build on Windows x64 with Node 24, Rust 1.88+, Git, CMake, Python for tests, and
Visual Studio 2022 Build Tools with Desktop development with C++:

    npm ci
    npm run check:windows
    npm run dist:win

The backend script pins Whisper source, downloads Base with a SHA-256 check,
verifies the CPU-only NeMo-Speech SDK and GGUF model, compiles both resident
adapters, and stages DLLs. Punctuation uses official embedded Python and hashed
Sherpa wheels/model from scripts/windows/pnc-dependencies.lock.json. No developer
cache or global Python installation is used by the installed application.
Build-time downloads require the network; installed dictation is offline.

The build checks native DLL import closure, rejecting missing VC runtimes and
GPU dependencies. Speech smoke tests run both workers repeatedly; a real
punctuation smoke test checks packaged Python/model output.

## Download buttons and release isolation

The README has independent links:

- Mac: /releases/latest/download/Open-Memo-latest-arm64.dmg (unchanged).
- Windows: /releases/download/windows-latest/Open-Memo-latest-windows-x64-setup.exe.

The Windows installer-check workflow runs on relevant pull requests and uploads
an artifact. It does not publish. The separate manual Windows release workflow
defaults to build-only. Publishing requires an existing v-version source tag
matching package.json, the commit on main with successful main CI, and
configured Windows signing (Azure or a certificate).

Public builds require code signing and a Valid Authenticode installer signature.
The workflow publishes immutable windows-v-version releases, plus a moving
windows-latest distribution tag with a stable filename and SHA256SUMS. Neither
Windows release is marked GitHub's latest release, preserving the Mac latest
pointer and updater. The moving tag changes only in the explicit publish action.
No workflow has been triggered by this local work.

The public Windows preview can also be distributed without signing through
**Publish Windows unsigned preview**. This is an explicit opt-in: provide the run
ID of a successful **Windows installer check** and set `publish_unsigned=true`.
It promotes that exact artifact, publishes an immutable `windows-preview-<sha>`
release with checksums/provenance, and updates the `windows-latest` URL. Both
releases are marked prerelease and never replace GitHub's latest macOS release.
The website and release notes must identify it as an **unsigned preview**. Windows
may display an unknown publisher or SmartScreen warning. Signing and clean-machine
acceptance are not claimed for this channel. The separate signed release workflow
continues to require signing. Merging, publishing, and local tests are separate actions.

## Release acceptance gates

Passing tests or running this development machine is not sufficient to call an
installer production-verified. Before public publication:

- Pass real Mac CI/build/signing checks for shared changes.
- Build NSIS from staged verified resources and inspect its payload.
- Install in a fresh standard Windows user/VM without developer tools or an
  installed VC runtime; finish onboarding, quit, and relaunch.
- Dictate into Notepad and a browser; check text, app/title/icons, hold/release,
  lock/unlock, optional Enter, shortcut/microphone editing, and history persistence.
- Disconnect networking after installation and verify speech and punctuation.
- Exercise explicit Base selection and forced Nemotron failure with Base fallback.
- Measure release-to-text delay and peak RAM for short/long speech with ordinary
  applications open; confirm a busy machine stays responsive.
- Test install-over-update/uninstall behavior, signature validation, and both
  download buttons after publication. Signed production releases require all
  these checks; an unsigned preview must disclose its narrower validation.

Local release-to-text timings cover native release through paste dispatch,
including formatting. They omit native stdout transit and target-app rendering.
Timing logs contain durations/backend names, not transcript text or microphone audio.

## Set up cloud signing for production

Microsoft Artifact Signing (formerly Trusted Signing) is supported through
our pinned electron-builder v26 Azure integration. Setup requires an Azure
subscription, a signing account, verified Public Trust publisher identity, and a
Public Trust certificate profile. Identity validation must be completed in the
Azure portal: https://learn.microsoft.com/azure/artifact-signing/quickstart

Create an Entra app registration/service principal, grant it the certificate
profile signer role scoped to that profile, and add these GitHub repository
secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
Use the secret value, not its ID. Do not put credentials in source or chat.

Add these GitHub repository Actions variables:

- `WIN_AZURE_ENDPOINT`: the signing account's regional HTTPS endpoint.
- `WIN_AZURE_ACCOUNT_NAME`: the signing account name.
- `WIN_AZURE_CERTIFICATE_PROFILE`: the Public Trust profile name.
- `WIN_AZURE_PUBLISHER_NAME`: the exact certificate subject common name.

Alternatively, configure `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` for an
existing exportable signing certificate. Configure only one signing method.
Partial Azure configuration fails rather than producing an unsigned installer.
The publish workflow also requires a Valid Authenticode signature before upload.

After main CI passes for the release commit, create its matching `v` version tag
and dispatch **Windows release** with that tag as `ref` and `publish=true`.
Complete the clean Windows installation/offline acceptance checks above before
publishing. Merging the PR does not make the Windows download button live.
