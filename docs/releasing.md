# Releasing

A release is a tag. Push it and `.github/workflows/release.yml` does the rest.

```bash
git tag -a v0.2.0 -m "taksim 0.2.0: a one-line summary

- the thing people will care about most
- the next one"
git push origin v0.2.0
```

The tag message becomes the top of the release page, so write it for users: a line that says what this version is,
then a few bullets. Users in China read the page too: put a line with just `[zh]` after the English part and write the
same intro in Simplified Chinese below it; the page ends with a Chinese section that has it and a Chinese install table
(without `[zh]` the section has only the table). The page gets the rest on its own:

| Part | From |
|---|---|
| intro | the tag message |
| What's changed | commit subjects since the previous tag (commits starting with `release:`, `tests:`, `ci:`, `site:`, `docs:` or `chore:` are left out) |
| Install | Homebrew, the disk image and the ZIP |
| SHA-256 | the checksums of both files |
| Full changelog | the compare link to the previous tag |

## Synchronized releases: Native and Electron

Native macOS and Electron (Linux & Windows) releases are strictly synchronized:
- **Zero release drift**: Every release tag triggers builds for both macOS (native) and Linux/Windows (Electron).
- **Parity required**: Features, bug fixes, and improvements are shipped together across all platforms.

The Linux and Windows app is `desktop/` packaged by electron-builder (`desktop/electron-builder.yml`). Like the Mac
app it carries the engine and its own Node (`desktop/scripts/stage-engine.mjs` stages bin, src, ui, toolbox, ws,
node-pty's binaries, Monaco and the runtime into `resources/engine`), so nothing needs to be installed first.

| File | For |
|---|---|
| `Taksim-<version>-Setup.exe` | Windows 10 or later, x64 and Arm in one installer, per user, no admin rights |
| `Taksim-<version>-<arch>.AppImage` | any Linux with glibc 2.28 or later, x64 and arm64 |
| `Taksim-<version>-<arch>.deb` | Debian and Ubuntu; installs an AppArmor profile on Ubuntu 24 |
| `latest.yml`, `latest-linux*.yml` | what installed apps read to update themselves (electron-updater) |

Each one is built on its own system in the `desktop` job (node-pty is compiled for Linux there) and run before it
ships: `desktop/test/package-smoke.mjs` starts the packaged app, which starts its engine with its own Node, an
agent answers in its chat, a real terminal opens in a node, and closing the window stops the engine. The
`desktop-publish` job adds the files to the release the macOS job created. The `test` workflow packages and runs
the Linux and Windows app the same way on every push.

Locally: `npm run desktop:dist` packages for this machine into `dist/desktop` (a Mac build is a folder, only for
trying the package). The Windows installer is not signed yet: SmartScreen asks once (More info › Run anyway).


## What the workflow does

1. Waits for the `test` workflow to pass on the tagged commit (up to 30 minutes), so tag after pushing, not before.
2. Builds the app, packs the engine and a Node runtime into it, signs everything inside with the Developer ID
   certificate (hardened runtime), sends it to Apple's notary service and staples the ticket. Apple's check usually
   takes minutes, but the first ones of a new account can take hours; the workflow waits up to three.
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
