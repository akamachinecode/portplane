# ADR-0012: mise, release-please, goreleaser and cosign; no OS code signing for v1

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** R4 and R2 in [open-questions.md](../open-questions.md)

## What it has to do

- Give contributors the same toolchain with one command.
- Turn Conventional Commits into versions, changelogs and releases without manual steps.
- Publish archives and packages for macOS, Linux and Windows on amd64 and arm64, built with CGO on darwin (ADR-0004) and without it elsewhere.
- Let users verify that a download is the one CI built.

## Options and facts

- **Toolchain:** mise pins Go, Node, pnpm, golangci-lint and goreleaser in `mise.toml`; the same file drives CI through `jdx/mise-action`.
- **Versioning:** release-please (action v5) keeps a release PR open from Conventional Commits; merging it tags the version and writes `CHANGELOG.md`.
- **Builds:** goreleaser (v2, open-source edition) running on a macOS runner can build darwin natively with CGO for both architectures, and every other target with `CGO_ENABLED=0`. Its `nfpms` section builds `.deb` and `.rpm`. Building per-OS on three runners and merging would need goreleaser Pro's split mode.
- **Signing:** Apple notarization needs a paid developer account; Windows Authenticode needs a certificate. Sigstore cosign (keyless, GitHub OIDC) signs the checksum file for free and records it in a public transparency log.

## Verdict

- **mise** for tools, **release-please** for versions, **goreleaser OSS on `macos-latest`** for builds, **cosign keyless** to sign `checksums.txt`.
- **No Apple notarization and no Windows code signing for v1.** Installers come from the landing page and GitHub Releases; the install script verifies the checksum, and the docs explain the one-time Gatekeeper ("Open Anyway") and SmartScreen ("Run anyway") prompts.
- Versions follow SemVer; 0.x until v1.0.

**Cost we accept:** a scarier first launch on macOS and Windows, and no listing in the main Homebrew cask repository; we publish our own tap instead.

**What would make us revisit it:** users dropping off at the first-launch prompt, or a sponsor covering the certificates.
