# macOS releases

Nexus supports macOS 12+ on Apple Silicon and Intel. Public releases must use a
Developer ID Application certificate, hardened runtime, and Apple notarization.
Ad-hoc signatures are only appropriate for local development.

## Configure GitHub

Connect this repository to GitHub and enable Actions. Add these repository secrets:

| Secret                       | Value                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded exported Developer ID Application `.p12`, including its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting that `.p12`                                           |
| `APPLE_SIGNING_IDENTITY`     | Full `Developer ID Application: Name (TEAMID)` identity                            |
| `APPLE_API_ISSUER`           | App Store Connect API issuer ID                                                    |
| `APPLE_API_KEY`              | App Store Connect API key ID                                                       |
| `APPLE_API_KEY_CONTENT`      | Complete downloaded `.p8` PEM private key                                          |

Use [Tauri's signing instructions](https://v2.tauri.app/distribute/sign/macos/) to
obtain/export the certificate and notarization credentials. Keep credential files
outside the repository; `.p12` and `.p8` files are ignored as an additional safeguard.
The workflow writes the notarization key to a runner temporary file with mode 0600
and removes it afterward. Tauri imports the certificate for the build.

## Prepare and build

1. Set the same version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`. Update lockfiles as needed.
2. Run the verification commands in README and perform its desktop smoke tests.
3. Commit the release changes and push a tag matching the application version,
   such as `v0.1.0`.
4. The release workflow runs verification, builds/signs/notarizes both architectures,
   notarizes the outer DMG separately, and checks the Developer ID signature, hardened runtime, stapled notarization
   tickets, Gatekeeper assessment, and binary architecture. Any failure stops it.
5. Only after both builds pass, the workflow creates a **draft** GitHub Release
   containing installers, app ZIPs, and SHA256 checksums. It never automatically
   publishes the draft or modifies a published release.
6. Download each architecture's artifacts, check the checksums, and test installation
   and AI setup on representative Macs before publishing the draft in GitHub.

Generated assets are named `Nexus_<version>_apple-silicon.dmg` and
`Nexus_<version>_intel.dmg`, with matching `.app.zip` archives and checksum files.
No signing credential or API key is bundled in Nexus.

## Build locally

Requires the Node/Rust/Xcode dependencies in README. Install the Developer ID
certificate and private key in Keychain, and configure `APPLE_SIGNING_IDENTITY`,
`APPLE_API_ISSUER`, `APPLE_API_KEY`, and `APPLE_API_KEY_PATH` in your shell.
`APPLE_API_KEY_PATH` points to the private `.p8` file; do not paste credentials
into tracked files or command history.

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run app:release
```

The default is a universal app/DMG. For an architecture-specific release:

```sh
npm run app:release -- --target aarch64-apple-darwin
npm run app:release -- --target x86_64-apple-darwin
```

Missing credentials stop the build before compilation. Verified downloads and
checksums are written to the ignored `release/<architecture>/` directory. Local
builds do not upload or publish anything.

## Installation and upgrades

Download the DMG matching the Mac's processor, open it, and drag Nexus into
Applications. Users do not need Node, Rust, or Xcode. Keep the app identifier
`dev.reece.ai-terminal` stable across releases.

For upgrades, quit Nexus before replacing the application. Settings, themes,
Keychain credentials, and local transcripts remain in their existing storage;
Keychain may ask for access when the signing identity changes. Live terminal
sessions and agent tasks are stopped when Nexus quits. Automatic updates are
outside this MVP; distribute each upgrade through the same Releases page.

## Current prerequisite

The workflow is implemented but signed public downloads are not verified until
it runs with valid Apple credentials in the configured GitHub repository.
