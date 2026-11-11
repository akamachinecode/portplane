# ADR-0007: Read portless routes from its state directory, behind the router adapter

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** A7 in [open-questions.md](../open-questions.md)

## What it has to do

Map each running app to its URL and internal port, and know whether the proxy runs on 443 with TLS, to build correct URLs.

Facts checked against portless 0.16.0:

- `portless list` prints a human table only; there is no `--json`.
- Routes live in `routes.json` in the state directory: `PORTLESS_STATE_DIR`, else `~/.portless`. Each entry has `hostname`, `port`, `pid` (0 for static aliases) and, since recent versions, `registeredAt`.
- The proxy writes `proxy.port` and `proxy.tls` next to it.
- `portless get <name>` prints one URL; `portless mcp` exposes routes over MCP (stdio), which is heavier than reading a file.

## Options

1. Parse `portless list` text: brittle.
2. Read `routes.json`, `proxy.port` and `proxy.tls`: simple, undocumented.
3. Talk to `portless mcp`: documented, but a long-running Node process per agent.

## Verdict

**Option 2, behind the router adapter.** The reader tolerates missing and unknown fields, and an unreadable file means "no routes", never a crash. We propose `portless list --json` upstream and switch to it when it ships.

**Cost we accept:** a portless release can change the file format; the view then loses URLs until the adapter is updated.

**What would make us revisit it:** `portless list --json` shipping.
