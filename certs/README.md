# Apple Signing And Notarization

Open Memo distributes a Developer ID signed and notarized macOS app outside the Mac App Store. Do not commit Apple certificates, private keys, passwords, or `.p8` files.

## What You Need To Provide Manually

For local signed validation on your MacBook:

- Apple Developer Program access for the team that owns the app.
- A `Developer ID Application` certificate with its private key installed in your local Keychain.
- An App Store Connect API key downloaded as `AuthKey_<KEY_ID>.p8`.
- The team ID, key ID, and issuer ID for that API key.

For GitHub Actions releases:

- A password-protected `.p12` export of the `Developer ID Application` certificate.
- The `.p8` App Store Connect API key encoded as base64.
- GitHub repository secrets listed below.

No provisioning profile is expected for the current Developer ID DMG/ZIP distribution. Provisioning profiles are generally for Mac App Store, sandboxed, or capability-specific distribution paths.

## Local Environment

Create `.env` from `.env.example` and set:

```bash
APPLE_TEAM_ID=YOUR_TEAM_ID
APPLE_API_KEY=/absolute/path/to/AuthKey_YOUR_KEY_ID.p8
APPLE_API_KEY_ID=YOUR_KEY_ID
APPLE_API_ISSUER=YOUR_ISSUER_UUID
```

Then validate signing locally:

```bash
./scripts/shell/deploy-production.sh
```

The script checks for a local `Developer ID Application` identity, builds through electron-builder, and writes artifacts to `$HOME/Builds/open-memo-dist` unless `OUTPUT_DIR` is set.

## GitHub Secrets

Add these in GitHub under Settings -> Secrets and variables -> Actions:

```text
APPLE_TEAM_ID
APPLE_API_KEY_BASE64
APPLE_API_KEY_ID
APPLE_API_ISSUER
APPLE_SIGNING_IDENTITY
MAC_CERT_P12
MAC_CERT_PWD
```

`APPLE_API_KEY_BASE64` should be the base64-encoded contents of `AuthKey_<KEY_ID>.p8`:

```bash
base64 -i AuthKey_YOUR_KEY_ID.p8 | pbcopy
```

`MAC_CERT_P12` should be the base64-encoded contents of your exported Developer ID Application certificate:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
```

`APPLE_SIGNING_IDENTITY` should look like:

```text
Developer ID Application: Your Name (TEAMID)
```

## Release Flow

The `.github/workflows/release.yml` workflow runs only for version tags or manual dispatch. It imports the signing certificate into a temporary CI Keychain, writes the App Store Connect API key into `private_keys/`, runs electron-builder signing/notarization, and publishes the GitHub Release artifacts.
