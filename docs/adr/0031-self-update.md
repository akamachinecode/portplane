# ADR-0031: Portplane updates itself on a click, and asks once whether to check every day

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amends:** [ADR-0025](0025-network-use.md): "For Portplane itself, the app shows the new version and how to get it. It does not replace itself." Automatic checks stay off until the user turns them on, but the app now asks.

## What it has to do

- Get a new version to the people who already run Portplane. Without that, every fix waits for each user to notice and reinstall by hand.
- Tell them a new version exists, in a place they look: Portplane lives in the menu bar or tray, so its window is often closed.
- Update in one click, with the same checks as an install, and never leave the user without a working Portplane.
- Keep ADR-0025's rule: no request the user didn't start or allow.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| A broken update never leaves Portplane broken | High | A user who loses the app after clicking "Update" stops trusting updates |
| Same trust as the first install | High | The update replaces the binary that has access to the user's projects |
| Works with each way Portplane is installed | High | `.app`, `install.sh`, `install.ps1`, `.deb`, `.rpm`, Homebrew |
| No new hosts and no telemetry | High | ADR-0025 and security.md |
| People find out | Medium | "When I ask" by default meant almost nobody would |
| Little code to keep | Medium | One maintainer; no framework |

## Options and facts

- **Sparkle (macOS), WinSparkle, AppImageUpdate:** one framework per OS, an appcast to publish, and an Objective-C dependency on macOS. Three systems for one Go binary.
- **A Go library (`go-selfupdate`, `minio/selfupdate`):** replaces one binary. It knows nothing about a `.app` bundle, the Linux window binary next to `portplane` (ADR-0018), or packages.
- **Our own, on what already exists:** the release already publishes every archive, `.dmg`, `.deb` and `.rpm` with a `checksums.txt` (ADR-0012). `installer.Downloader` already downloads only from official hosts and checks SHA-256 as it streams (ADR-0019). `privileged.Run` already asks for the password through the system's dialog (ADR-0020). `jobs` already shows progress (ADR-0024). The new part is detecting how Portplane was installed, swapping files and restarting: a few hundred lines.
- **Renaming a running binary** works on macOS, Linux and Windows. A running `.exe` can't be deleted, but it can be renamed. The process keeps the old file and the next start runs the new one.
- **Restarting:** the new process must start after the old one quits, or it finds the old one running and only shows its window. A version that predates this ADR doesn't know any new flag.
- **Signatures:** `checksums.txt` is signed with cosign keyless (ADR-0012). Checking that signature in the app needs the sigstore libraries (a large dependency tree) or a `cosign` binary that most users don't have, and it contacts Sigstore's hosts. The remote agent install (ADR-0015) and `install.sh` without cosign check the SHA-256 only.

## Verdict

**Portplane updates itself with its own small updater (`internal/selfupdate`), built on the downloader, the password dialog and jobs it already has.**

- **How it was installed decides how it updates:**

  | Installed with | Detected by | "Update and restart" |
  |---|---|---|
  | `install.sh`, `install.ps1`, an unpacked archive | a binary in a folder the user can write | swaps `portplane` (and `portplane-window` on Linux) for the release archive's |
  | `Portplane.app` | the binary is in `….app/Contents/MacOS` | copies the bundle out of the release `.dmg` (`hdiutil`, `ditto`) and swaps the whole `.app` |
  | `.deb` / `.rpm` | `/usr/…`, and dpkg's list or `rpm -qf` | installs the release package with `dpkg -i` / `rpm -U`, through the password dialog |
  | Homebrew | `Cellar`, `/opt/homebrew`, `linuxbrew` | shows `brew upgrade portplane` |
  | A folder the user can't write, `/usr` with no known package, a development build | — | says why, and links to the release |

- **Checked like an install:** only from GitHub's release URLs (the official hosts of ADR-0025). Each file must match `checksums.txt` of the same release, or nothing changes.
- **Never left broken:** files are staged next to the target and renamed into place, keeping the old ones. The new binary must run `portplane version --json` and report the expected version. Otherwise the old files go back. Leftovers from an interrupted update are removed at the next start.
- **Restart:** the old Portplane starts the new one detached, then quits. On macOS and Linux a fixed `/bin/sh` script waits for the old process to end and then `exec`s the new binary, so the restart works whatever version is installed. On Windows the new Portplane waits by itself, through `PORTPLANE_AFTER_PID`. Older versions ignore that variable, so it never breaks a start. The window opens again.
- **Only a release with its files:** GitHub marks a release as latest minutes before the release workflow has uploaded its files. A check reports a new Portplane only once that release's `checksums.txt` answers. Until then it says the version is still being published.
- **Only what the last check found:** the server installs the latest version from the last check, only when it is newer than the running one. The page can't choose another version.
- **Finding out:**
  - **Ask once.** Until the user answers, the sidebar asks: "Get new versions? Portplane asks GitHub once a day…", with **Check daily** and **Not now**. The answer is kept (`updateAsked`). Checks stay off by default, as in ADR-0025.
  - **When there is one,** the sidebar shows "Portplane X is out · Update and restart", which opens Settings › Updates with the button and the job's progress.
  - **With daily checks on,** a system notification announces each new version once, even with the window closed.
- dekit and portless keep updating through their own pages (ADR-0019). Remote agents keep being replaced by version on connect (ADR-0015).

**Cost we accept:**

- The app checks the SHA-256 against `checksums.txt` but not cosign's signature of `checksums.txt`. Someone who could publish a release on the repository could ship an update. That is the same trust as the landing page, `install.sh` without cosign and the remote agent install.
- A user who answers "Not now" and never checks still never hears about new versions from the app.
- Each install method is a code path to keep working. The release's file names (goreleaser's `name_template` and nfpm's conventional names) are now part of the contract, and `selfupdate.Asset` must follow any change to them.
- Users on 0.5.0 or earlier update once by hand to reach a version with the button.

**What would make us revisit it:**

- A signing key in CI (minisign or the like) with its public key embedded in the binary: that would let the app check a signature with no new dependency or host.
- Notarization (ADR-0012), which may change how a replaced `.app` is treated.
- A package repository (apt, dnf, Homebrew tap) that makes the system's own updater the better path.
