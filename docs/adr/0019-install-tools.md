# ADR-0019: Install dekit and portless from their official sources, and a private Node 24 when there is none

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** the verdict on installing dependencies (P5) in [ADR-0014](0014-setup-scope.md), "guide, never install". Setup no longer stops at showing the commands for dekit, Node.js and portless. The sentence that privileged commands are "only ever shown" is superseded by [ADR-0020](0020-privileged-steps.md). The scanner scope (P3) and the rules for generated tasks stand.

## What it has to do

M5's goal: someone without dekit, without portless and maybe without Node.js downloads Portplane and reaches their first app at `https://<name>.localhost` without opening a terminal. ADR-0014 stopped at commands to copy, which puts the user in a terminal on first run. That is the step M5 removes.

- Install dekit and portless for the current user, with no password.
- Install only from each project's own sources, and run no downloaded binary whose checksum was not checked.
- Say what will happen before it happens: the source, the version and the folder.
- Work when Node.js is missing or older than 24, which portless needs.
- Leave tools that `dekit update`, npm and the user's terminal still understand. Someone who goes back to the terminal loses nothing.
- See a tool installed while Portplane is open, without a restart.
- macOS, Linux and Windows.

ADR-0014 named its own trigger: "official installers for dekit and portless that run without privileges and can be verified". They exist:

- dekit publishes `install.sh` and `install.ps1` at `https://dekit.run`. The script downloads a release from dekit's GitHub releases, checks it against the release's `SHA256SUMS`, installs it in `~/.local/bin` and leaves a receipt that `dekit update` reads. dekit publishes no checksum for the script itself.
- portless is an npm package. `npm install -g portless` runs as the user when npm's global prefix belongs to the user. npm checks each package against the integrity hash the registry lists.
- Node.js publishes builds for each OS and architecture at `https://nodejs.org/dist/`, with a `SHASUMS256.txt` per release.

The portless service records the path of the Node that installed it. On one machine checked for this plan, the service pointed at a versioned Homebrew path (`<brew prefix>/Cellar/node/<version>/bin/node`), which the next `brew upgrade node` removes.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| No terminal on first run | High | The goal of M5; "copy these commands" is what users asked to drop |
| Official sources, checksums checked | High | A download that runs is the largest new risk |
| No password for installs | High | The only admin step should be the proxy (ADR-0020) |
| The terminal keeps working | High | Vision: no lock-in; `dekit update` and npm must still know the tools |
| Leaves the user's own Node alone | Medium | Other projects depend on it |
| Code to maintain | Medium | One maintainer |

## Options

**dekit**

| | Run dekit's official installer | Download the release and check it ourselves | A package manager (Homebrew, npm, pip) | Keep showing the command (ADR-0014) |
|---|---|---|---|---|
| Checksum | The script checks the binary against `SHA256SUMS`; the script has none | Yes, against `SHA256SUMS` | The manager's own | The user's |
| `dekit update` works after | Yes: the script leaves its receipt | No, unless we copy the receipt format, which is internal to dekit | Through the manager | Yes |
| Available | Everywhere | Everywhere | Only where the manager is installed | Everywhere |
| Terminal on first run | No | No | No | Yes |
| Code | Small | Medium | Small per manager | None |

**Node.js and portless**

| | The user's Node 24+, `npm install -g` | A private Node 24, portless in a private prefix | A version manager the user has (mise, fnm, volta, nvm) | Ask the user to install Node |
|---|---|---|---|---|
| Works with no Node | No | Yes | Only when one is installed | No |
| Touches the user's Node | Adds one global package | No | Changes its global default | — |
| Checksum | npm's integrity check | `SHASUMS256.txt` for Node; npm's check for portless | The manager's | — |
| Node path the service records | The user's Node | A Portplane folder, per version | A versioned folder of the manager | — |
| Terminal on first run | No | No | No | Yes |

## Verdict

**Portplane installs dekit and portless itself, for the current user, from official sources only, after showing what it will do. When there is no Node.js 24 or later, it installs a private one for portless.**

Before each install, a card says the source, the version and the folder ("dekit 0.x from dekit's GitHub releases, checked with SHA-256, into `~/.local/bin/dekit`. No password."). Nothing runs before the click. Each install is a job with stages and output (ADR-0024). A failed one shows its error and output, with Retry and "Copy the command to do it by hand".

**dekit.**

- Portplane downloads `install.sh` (macOS, Linux) or `install.ps1` (Windows) from `https://dekit.run` into a temporary file. It runs that file with `sh` or PowerShell, as argv. It never pipes a download into a shell.
- The script checks the release against `SHA256SUMS` and installs it in `~/.local/bin` (`~\.local\bin` on Windows, added to the user's Path).
- Portplane then runs `dekit --version`.

**Node.js, only when none of version 24 or later is found.**

- The default card reads "Install Node 24 for Portplane only (does not touch your Node)".
- Portplane downloads the official archive for the OS and architecture from `https://nodejs.org/dist/`, with that release's `SHASUMS256.txt`, and checks the SHA-256 before unpacking.
- It unpacks into Portplane's data folder: `~/.local/share/portplane/node/<version>` on Linux, `~/Library/Application Support/portplane/node/<version>` on macOS, `%LocalAppData%\portplane\node\<version>` on Windows.
- It changes nothing on PATH. Only portless uses it.
- When mise, fnm, volta or nvm is installed, Portplane offers it as a second choice, for example `mise use -g node@24`.

**portless.**

- With the user's Node 24 or later, and an npm global prefix the user owns: `npm install -g portless`.
- Otherwise (the private Node, or a global prefix owned by root, as with a system Node in `/usr`): portless goes into a private npm prefix next to the private Node. Portplane writes a `portless` launcher in `~/.local/bin`, next to dekit (a `.cmd` file on Windows).
- Then `portless --version` and `portless doctor`, which only reads.
- On Windows, portless needs `openssl`. Portplane checks for it and shows how to get it. It does not install OpenSSL itself.

**PATH.** If `~/.local/bin` is not on the login shell's PATH, Portplane offers to add one line to the shell's profile file and shows the line first. Portplane does not need it: it calls the tools by absolute path. The line is only for the terminal, and saying no changes nothing else.

**Tools already installed.** Portplane detects how each tool was installed: dekit's receipt, Homebrew, npm, pip, mise, or Portplane's private prefix. It updates a tool with the method that installed it, and never installs a second copy next to it.

**Finding new tools.** Portplane looks up `dekit` and `portless` on every check, with a 5-second cache, and recomputes PATH after each install. Today it looks them up once at start, so a tool installed while Portplane runs stays "missing" until a restart.

**Local machine only.** Remote machines keep showing the commands until remote parity (M5.6).

**Cost we accept:**

- dekit's install script is the one download that runs without a checksum of its own, because dekit publishes none. Portplane fetches it only from `https://dekit.run` over HTTPS. That is the same trust as the one-line install dekit documents, and the script then checks the binary it installs.
- The checksums come from the same server as the files. They catch a broken or altered download, not a compromised server. nodejs.org also publishes a signed `SHASUMS256.txt`. Checking that signature needs the Node release keys inside Portplane, which we leave for later.
- A second Node on disk for users who have none, or only an old one.
- Every versioned Node path can break the portless service: Homebrew's Cellar, a version manager's folder, and Portplane's own `node/<version>`. Portplane keeps a private Node version while the service still uses it. The health view flags a service whose Node is gone, with a button to reinstall it (ADR-0020).
- Three installers that can change upstream, and install code per OS. Each step reports its stage and output, so a broken step shows instead of failing silently.

**What would make us revisit it:** dekit publishing a checksum or signature for its install scripts; an upstream change that breaks the receipt or the npm layout; portless dropping its Node requirement; reports that the private Node confuses people who already manage Node.
