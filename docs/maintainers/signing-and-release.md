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

`APPLE_SIGNING_IDENTITY` should look like:

```text
Developer ID Application: Your Name (TEAMID)
```

## Release Flow

GitHub Actions is the source of truth for public releases.

1. Update `package.json` and `CHANGELOG.md`.
2. Merge to `main`.
3. Create an annotated version tag, for example:

   ```bash
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```

4. The release workflow imports the signing certificate into a temporary CI Keychain, writes the App Store Connect API key into `private_keys/`, runs electron-builder signing/notarization, and publishes GitHub Release artifacts.

## Local Verification

After building locally or downloading a release, verify:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Memo.app
spctl --assess --type execute --verbose /Applications/Memo.app
```
