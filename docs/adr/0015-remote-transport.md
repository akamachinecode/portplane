# ADR-0015: Reach other machines with the system ssh and an uploaded agent speaking over stdio

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** A4 in [open-questions.md](../open-questions.md)

## What it has to do

Show another machine's dev servers next to the local ones, act on them, and open them, with:

- the user's existing SSH setup (`~/.ssh/config`, agents, keys, ProxyJump, Tailscale SSH);
- no listener and no service installed on the remote machine (principle 5);
- live updates without polling over a slow link;
- the same code that serves the local machine (ADR-0005).

## Options

| | Agent over stdio (chosen) | Agentless: run `ss`/`lsof`/`dekit ls` per poll |
|---|---|---|
| Remote requirements | The portplane binary, uploaded by the app | Shell tools that differ per OS |
| Updates | Pushed by the agent on change | Polled; one SSH command per poll per tool |
| Connection reuse | One ssh process for everything | Needs ControlMaster, which Windows' OpenSSH lacks |
| Code reuse | The local agent, unchanged | A second implementation of collection |

## Verdict

- The app runs the **system `ssh`** (`-T`, `BatchMode=yes`, keep-alives) to start `portplane agent --stdio` on the remote machine. Remote scripts run through `sh -c`, so fish or zsh login shells do not matter.
- **Install:** the app probes `uname -s -m`, picks the binary for that platform (itself when it matches, otherwise the release archive for the same version, checked against `checksums.txt`), and uploads it over the same ssh to `~/.cache/portplane/<version>-<sha256 prefix>/portplane`, verifying the SHA-256 on the remote side. Nothing else is written on the remote machine.
- **Protocol:** [yamux](https://github.com/hashicorp/yamux) multiplexes the session's stdin and stdout. The first stream is control: JSON lines with `hello` (protocol version check), `setFolders`, `watch`, `act`, `up`, `excerpt` and `setInterval` requests, and `snapshot` notifications pushed by the agent. Every other stream is a TCP dial to a port on the remote machine.
- **PATH:** a process started by non-interactive ssh gets a minimal PATH (`/usr/local/bin:/usr/bin` in testing), so the agent adds the login shell's PATH and the usual install folders before looking for dekit and portless. The desktop app does the same at start-up.
- **Failure:** a dropped connection marks the machine offline (its apps disappear from "running") and reconnects with backoff up to 30 seconds.
- Remote machines run macOS or Linux. Windows remotes are not supported in v1.

**Cost we accept:** a binary in the remote user's cache folder per version; one long-lived ssh process per machine; a protocol version both ends must share.

**What would make us revisit it:** a need for Windows remotes, or for remote machines without a POSIX shell.
