# ADR-0002: Write Portplane in Go

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** A1 in [open-questions.md](../open-questions.md)

## What it has to do

- Run on macOS, Linux and Windows, on amd64 and arm64.
- Read listening TCP ports, the owning process and its working directory on all three.
- Run other programs (`dekit`, `portless`, `git`, `ssh`) and read their output.
- Serve a small web UI and an API on loopback.
- Run as an agent on a remote machine over SSH, where nothing but the binary can be assumed: no runtime, no package manager, often no desktop libraries.
- Be built and released by one maintainer.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| One static binary per OS and architecture | High | The same file is copied to remote machines (principle 4) |
| Cross-platform process and port inspection | High | Core of the product |
| Cross-compilation from one machine | Medium | Releases for six targets |
| Ecosystem for SSH, multiplexing, YAML | Medium | M3 and the dekit config reader |
| Maintainer familiarity and reuse | Medium | Exhale is Go: CI, release and lint setup carry over |

## Options

| | Go | Rust | Node (TypeScript) |
|---|---|---|---|
| Static binary | Yes, `CGO_ENABLED=0` | Yes, more setup for musl and Windows | Needs a bundled runtime (SEA or pkg), 40–90 MB |
| Ports and processes | `gopsutil` v4.26.10 (BSD-3-Clause, monthly releases) | `sysinfo`, `netstat2` | Shelling out per OS |
| Cross-compile | Built in | Needs a target toolchain per OS | n/a |
| Familiarity | High | Low | High |

Spike, 2026-11-11: a program using `gopsutil` to list listening sockets with their PID, executable and working directory built with `CGO_ENABLED=0` for linux, windows and darwin on amd64 and arm64. On Linux it reported every dev server's port and folder correctly. On macOS `gopsutil` reaches `libproc` through `purego`, so no C toolchain is needed.

## Verdict

**Go**, at the latest stable release (1.27 today), pinned with mise.

**Cost we accept:** a larger binary than Rust (around 15–25 MB with the embedded UI), and a garbage collector we do not need.

**What would make us revisit it:** a need for a native UI toolkit that Go cannot bind without CGO on every OS.
