# Signing And Release

This guide is for maintainers who publish signed Open Memo releases for macOS.

Open Memo distributes a Developer ID signed and notarized app outside the Mac App Store. Do not commit Apple certificates, private keys, passwords, `.p8` files, or exported `.p12` files.

## Manual Apple Setup

For local signed validation on your Mac:

- Apple Developer Program access for the team that owns the app.
- A `Developer ID Application` certificate with its private key installed in your local Keychain.
- An App Store Connect API key downloaded as `AuthKey_<KEY_ID>.p8`.
- The team ID, key ID, and issuer ID for that API key.

For GitHub Actions releases:

- A password-protected `.p12` export of the `Developer ID Application` certificate.
- The `.p8` App Store Connect API key encoded as base64.
- The GitHub repository secrets listed below.

No provisioning profile is expected for the current Developer ID DMG/ZIP distribution. Provisioning profiles are generally for Mac App Store, sandboxed, or capability-specific distribution paths.

## Local Signed Validation

Create `.env` from `.env.example` and set:

```bash
APPLE_TEAM_ID=YOUR_TEAM_ID
APPLE_API_KEY=/absolute/path/to/AuthKey_YOUR_KEY_ID.p8
APPLE_API_KEY_ID=YOUR_KEY_ID
APPLE_API_ISSUER=YOUR_ISSUER_UUID
```

Then run:

```bash
./scripts/shell/deploy-production.sh
```

The script checks for a local `Developer ID Application` identity, builds through electron-builder, and writes artifacts to `$HOME/Builds/open-memo-dist` unless `OUTPUT_DIR` is set.

## GitHub Actions Secrets

Add these in GitHub under **Settings -> Secrets and variables -> Actions**:

```text
APPLE_TEAM_ID
APPLE_API_KEY_BASE64
APPLE_API_KEY_ID
APPLE_API_ISSUER
APPLE_SIGNING_IDENTITY
MAC_CERT_P12
MAC_CERT_PWD
MEMO_FIRMWARE_READ_TOKEN
```

Encode the App Store Connect API key:

```bash
base64 -i AuthKey_YOUR_KEY_ID.p8 | pbcopy
```

Save that as `APPLE_API_KEY_BASE64`.

Encode the exported Developer ID Application certificate:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
```

Save that as `MAC_CERT_P12`.

`MEMO_FIRMWARE_READ_TOKEN` is a fine-grained GitHub token selected only for the
private `oliverbhull/memo-firmware` repository with read-only Contents access.
It is used by the scheduled mirror workflow and is never packaged into Open
Memo.

`APPLE_SIGNING_IDENTITY` should look like:

```text
Developer ID Application: Your Name (TEAMID)
```

## Release Flow

GitHub Actions is the source of truth for public releases.

1. Update the version in `package.json` and `package-lock.json`.
2. Merge to `main`.
3. Create an annotated version tag, for example:

   ```bash
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```

4. The release workflow imports the signing certificate into a temporary CI Keychain, writes the App Store Connect API key into `private_keys/`, runs electron-builder signing/notarization, and publishes GitHub Release artifacts.

## Firmware Release Flow

Firmware source and its primary release stay in the private `memo-firmware`
repository. That repository's release workflow signs the exact
`memo-firmware-release.json` bytes with its `MEMO_FIRMWARE_SIGNING_KEY` Ed25519
Actions secret. The matching public key is pinned in Open Memo.

Every 15 minutes, `mirror-firmware-release.yml` uses the read-only token to
download the newest private firmware release. It verifies all bundle checksums,
the signature, the signed release tag, and an exact asset allowlist before
publishing the same binary assets publicly in this repository. Firmware
releases are marked as GitHub prereleases so they do not replace the current
Open Memo application release; the label is a channel-routing mechanism, not a
firmware quality designation.

Open Memo filters for the newest `firmware-v*` prerelease, verifies the embedded
publisher key, and downloads the UF2 only when the connected device reports a
different version. Shipping the updater requires one Open Memo application
release. Firmware published after that does not require another application
release.

The firmware signing private key must never be committed. Keep a recovery copy
in the maintainer's protected credential store; the active signing copy is the
private firmware repository's `MEMO_FIRMWARE_SIGNING_KEY` Actions secret.

## Local Verification

After building locally or downloading a release, verify:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Memo.app
spctl --assess --type execute --verbose /Applications/Memo.app
```
