# Releasing

A release is a tag. Push it and `.github/workflows/release.yml` does the rest.

```bash
git tag -a v0.2.0 -m "taksim 0.2.0: a one-line summary

- the thing people will care about most
- the next one"
git push origin v0.2.0
```

The tag message becomes the top of the release page, so write it for users: a line that says what this version is,
then a few bullets. The page gets the rest on its own:

| Part | From |
|---|---|
| intro | the tag message |
| What's changed | commit subjects since the previous tag (commits starting with `release:`, `tests:`, `ci:`, `site:`, `docs:` or `chore:` are left out) |
| Install | Homebrew, the disk image and the ZIP |
| SHA-256 | the checksums of both files |
| Full changelog | the compare link to the previous tag |

## What the workflow does

1. Waits for the `test` workflow to pass on the tagged commit (up to 30 minutes), so tag after pushing, not before.
2. Builds the app, packs the engine and a Node runtime into it, signs everything inside with the Developer ID
   certificate (hardened runtime), sends it to Apple's notary service and staples the ticket.
3. Makes `Taksim-<version>.zip` (the app updates itself from it and the Homebrew cask installs it) and
   `Taksim-<version>-arm64.dmg` (signed and notarized too), each with a `.sha256`.
4. Creates the GitHub release and updates the cask in the tap, `0xhalil/homebrew-taksim`.

## Trying it first

*Actions › release › Run workflow* with a version and *publish* left off builds, signs and notarizes the same way
and leaves the files as a downloadable artifact, without creating a release. Locally, `native/scripts/release.sh
<version>` does the unsigned build and prints the release page it would publish.

## Secrets

| Secret | What |
|---|---|
| `APPLE_CERT_P12`, `APPLE_CERT_PASSWORD` | the Developer ID Application certificate, base64 of the `.p12`, and its password |
| `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | an App Store Connect API key, for notarization |
| `TAP_DEPLOY_KEY` | a deploy key with write access to the tap repository only |
| `DEPLOY_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS` | the website deploy (see `site/README.md`) |
