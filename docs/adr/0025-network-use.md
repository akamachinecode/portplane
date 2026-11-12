# ADR-0025: Use the network only for downloads the user starts and update checks the user asks for

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amends:** the network rule in [security.md](../security.md): "no update checks", and GitHub Releases as the only host besides the user's SSH machines. Covers the downloads of [ADR-0019](0019-install-tools.md).

## What it has to do

Until now Portplane made two kinds of outgoing requests: to the user's SSH hosts, and to GitHub Releases for an agent binary of another platform (ADR-0015). M5 needs two more:

- The downloads behind ADR-0019's installs: dekit's installer and release, Node.js, and portless from npm.
- Knowing when dekit, portless or Portplane has a newer version, so the user can update from the app.

The vision's principle 3 still holds: local-first, no accounts, zero telemetry.

- No request the user did not start or turn on.
- A short, fixed list of hosts, each an official source.
- Nothing about the user or their projects in any request.
- Everything but installs and update checks works offline.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| No traffic the user did not ask for | High | Vision, principle 3 |
| Official sources only | High | ADR-0019 |
| Updates are easy to find | Medium | An old dekit or portless breaks things, and the app should say so |
| Code | Low | A version check is a small request |

## Options

| | Check on a click; automatic only if turned on | Check in the background by default | Never check (today) |
|---|---|---|---|
| Traffic without consent | None | At every start | None |
| User learns about updates | When they look, or on their own schedule after opting in | Always | Never from the app |
| Fits principle 3 | Yes | No | Yes |

## Verdict

**Portplane goes to the network only when the user starts a download or an update check, or after the user turns on automatic checks, and only to these hosts:**

| Host | What for | Integrity |
|---|---|---|
| GitHub, Portplane's releases | Agent binaries for other platforms (ADR-0015); Portplane's latest version | `checksums.txt` |
| `dekit.run` | dekit's `install.sh` and `install.ps1` | HTTPS only (ADR-0019) |
| GitHub, dekit's releases | The dekit release, downloaded by its installer; dekit's latest version | `SHA256SUMS`, checked by the installer |
| `registry.npmjs.org` | portless and its dependencies; portless's latest version | npm's integrity hashes |
| `nodejs.org` | Node.js builds from `/dist/`, and the list of releases | `SHASUMS256.txt` |

"GitHub" means `github.com` and the host it redirects release files to.

- **Update checks.** "Check for updates" in Settings checks dekit, portless and Portplane on a click. A "Check automatically" switch, off by default, checks at most once a day while Portplane runs.
- **A check only reads.** It reads the latest version and compares it with the installed one. Updating is a separate click, through the method that installed the tool (ADR-0019). For Portplane itself, the app shows the new version and how to get it. It does not replace itself.
- **What is sent.** HTTPS `GET` requests with no cookies and no identifiers, and a `User-Agent` of `portplane/<version>`.
- **npm's registry.** npm uses the registry in the user's npm config, `registry.npmjs.org` unless the user set another. Portplane does not override it, so a company mirror keeps working.
- **Offline.** A failed check or download says so and changes nothing.
- **Settings → Privacy and network** lists these hosts and when each one is used.

**Cost we accept:**

- Each request tells that host the user's IP address and that they run Portplane, when they click, or once a day after they opt in.
- Someone who never clicks does not learn about new versions from the app. The health view still flags a version older than the minimum Portplane supports, which needs no network.
- A longer list of hosts to keep right in the security docs.

**What would make us revisit it:** a request to check without consent; an official source moving to another host; an install that needs a host not on this list.
