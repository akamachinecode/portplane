# ADR-0020: Run privileged steps only on a click, through the system's password dialog

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** the rule in [security.md](../security.md) that Portplane never runs anything with elevated privileges, and the sentence in [ADR-0014](0014-setup-scope.md) that privileged commands are "only ever shown".

## What it has to do

A few portless steps need admin rights:

- `portless service install` and `uninstall`: a system service that runs the proxy on port 443 when the computer starts;
- `portless trust`: the local CA in the system's trust store;
- `portless hosts sync` and `clean`: the `# portless-start` block in `/etc/hosts`, needed only for a TLD other than `.localhost`;
- `portless proxy start` and `stop` on a port below 1024, or when the proxy runs as root.

Today Portplane shows `sudo portless service install` and the user runs it in a terminal. M5 wants a first run with no terminal, where the password is asked once, for the proxy.

- Nothing elevated runs without an explicit click on a button that says it will ask for the password.
- The user sees the exact command first.
- The password goes to the operating system, never to Portplane.
- No shell between Portplane and the command (ADR-0010).
- portless keeps its state in the user's home, owned by the user, as it does under `sudo`. Without that, portless running as root writes to root's home, and the user's own calls do not see it.
- A way to get HTTPS URLs without admin rights at all.
- When no system dialog is available, the user can still do the step by hand.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Portplane never sees the password | High | A desktop app should not handle admin credentials |
| The user sees what runs, before it runs | High | The security model |
| No shell string | High | An argument with spaces or quotes must not become code (ADR-0010) |
| State stays the user's | High | Terminal and app must see the same portless state |
| Works on the three systems | Medium | Linux, macOS, Windows (beta) |
| Code to maintain | Medium | One maintainer |

## Options

| | The system's dialog: pkexec, `osascript … with administrator privileges`, UAC | A privileged helper of ours, installed once | `sudo` in a terminal Portplane opens | Show the command (today) |
|---|---|---|---|---|
| Password goes to | The OS | The OS, once | The OS, through a terminal | The OS, through the user's terminal |
| What runs is shown first | Yes, by Portplane | Only when the helper is installed | Yes | Yes |
| Shell | None on Linux; on macOS, the one `do shell script` starts | None | The terminal's | The user's |
| New code running as root | None | A long-lived component of ours | None | None |
| Terminal on first run | No | No | Yes | Yes |
| Needs | A polkit agent on Linux; not blocked by Mac management | Same, once | A terminal app | Nothing |

Facts:

- `pkexec` runs a program as root once polkit has authenticated the user. It replaces the environment with a minimal one, so variables have to travel in argv, through `/usr/bin/env`. It needs a polkit authentication agent, which desktop sessions usually run.
- macOS has no argv form. `do shell script` takes one command string and runs it with `/bin/sh`. AppleScript's `quoted form of` quotes one argument for that shell. When each argument reaches `osascript` as an argument of its own and a fixed script quotes it, Portplane never builds the string.
- Windows starts an elevated program with `ShellExecuteEx` and the `runas` verb, which shows UAC. That call cannot pipe the program's output back. How the environment reaches the elevated program needs a spike.

## Verdict

**Privileged steps run only when the user clicks a button that says it will ask for the password. Portplane shows the exact command first, then hands it to the system's own password dialog. Portplane never sees the password.**

- **Which steps.** Only the portless commands listed above, with arguments built by Portplane from the user's choices. The API endpoint that starts one takes the choices ("the service on 443, with HTTPS"), never a command, so the page cannot ask for anything else.
- **Before the dialog.** The button says what will happen ("Asks for your password: installs a service that starts the proxy when your computer starts"). A confirmation then shows the argv, one argument per line, and the environment that goes with it.
- **Argv only.** argv[0] is an absolute path, because the elevated side gets a minimal `PATH`. portless runs on Node, so the argv names that Node and portless's entry script by absolute path.
- **Environment.** `HOME`, `PORTLESS_STATE_DIR`, `SUDO_UID` and `SUDO_GID`, with the user's values, so portless keeps its state in the user's home and hands its files back to the user, as under `sudo`. Nothing else.
- **Per system:**
  - **Linux:** `pkexec /usr/bin/env HOME=… PORTLESS_STATE_DIR=… SUDO_UID=… SUDO_GID=… <node> <portless> service install …`. The output streams live.
  - **macOS:** `osascript` with a fixed script that quotes each argument with `quoted form of` and runs the result through `do shell script … with administrator privileges`. The arguments, the `env` assignments included, reach `osascript` as separate arguments. The output shows when the step ends.
  - **Windows:** UAC through `ShellExecuteEx` with `runas`. A spike before M5.1 decides how the environment reaches portless and how the output comes back.
- **After the step.** Each step is a job (ADR-0024). Portplane then checks the result itself: the service answers, the CA is trusted, `https://portplane.localhost` loads.
- **Fallback.** When no dialog can open (no polkit agent, a Mac whose management blocks it), or when the user prefers, Portplane shows the same command with `sudo`, to copy, as before.
- **Without admin rights.** "No password (port 1355)" starts the proxy as the user on port 1355, and URLs carry the port: `https://web.localhost:1355`. On Linux, ports 80 and 443 without root need a `sysctl` change, itself an admin step, so 1355 is the option that needs no password at all.
- **Not privileged.** Trusting the CA in a browser's own certificate database (Firefox profiles, Chrome's NSS database on Linux) writes into the user's profile and needs no password. Which browsers need it, per OS and per packaging (snap, flatpak), needs a spike before M5.1.
- **Local machine only.** A remote machine has no desktop where a dialog could open. Remote parity (M5.6) needs its own decision.

**Cost we accept:**

- On Linux, polkit's dialog names the program it runs, which is `/usr/bin/env`, not portless. Portplane's confirmation is where the user reads the real command.
- macOS still goes through one shell, the one `do shell script` starts. AppleScript does the quoting, not Portplane, and tests cover spaces, quotes and `$` in arguments.
- On macOS the output appears only when the step ends.
- The programs that run as root, Node and portless, can live in folders the user can write: Portplane's data folder, a user-owned npm prefix, Homebrew. A program running as the user could change them before the next elevated step, or before the service restarts. `sudo portless service install` with a user-installed Node has the same weakness today. The security review before M5.1 decides whether privileged steps need a root-owned copy.
- The API cannot tell a click from a script in the page. The per-run token (ADR-0008) keeps other sites out, and the password dialog is the last check.
- Three mechanisms to build and test, and the Windows one not tried yet.

**What would make us revisit it:** portless offering a narrower way to bind port 443 or to trust its CA; reports that the dialogs are blocked on common setups; the security review asking for root-owned binaries in privileged steps.
