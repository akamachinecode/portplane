# ADR-0008: Protect the loopback API with a Host allowlist and a per-run token

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** the security side of A3 in [open-questions.md](../open-questions.md)

## What it has to do

The binary serves the UI and a JSON API on loopback (ADR-0004). That API starts and stops processes and can open SSH connections. Any web page the user visits can send requests to `127.0.0.1`, and a hostile DNS name can be rebound to `127.0.0.1`. The API must answer only to the Portplane UI.

## Threats

| Threat | Example |
|---|---|
| Cross-site request forgery | A page posts a form or `fetch` to `http://127.0.0.1:<port>/api/actions` |
| DNS rebinding | `evil.example` resolves to `127.0.0.1`; the page then reads the API as same-origin |
| Other local users | On a shared machine, another user connects to the port |
| Network exposure | The listener is reachable from the LAN |

## Verdict

- **Loopback only:** listen on `127.0.0.1` on a random free port. Never on `0.0.0.0`. This is not a network listener in the sense of the vision's principle 5.
- **Host allowlist:** requests must carry `Host: 127.0.0.1:<port>`, `localhost:<port>` or `portplane.localhost` (with or without a port). Anything else gets 403. This defeats DNS rebinding.
- **Per-run token:** a random 256-bit token is generated at start and written into the served `index.html`. Every `/api` request must send it in `X-Portplane-Token` (or `?token=` for the event stream, since `EventSource` cannot set headers). Cross-site pages cannot read the page, so they cannot learn the token. This defeats CSRF.
- **No CORS headers**, JSON request bodies only, and an `Origin` header, when present, must match an allowed host.
- **Content Security Policy** on the UI: `default-src 'self'`.

**Cost we accept:**

- Other users of the same machine can connect to loopback, fetch the page and read the token. Portplane targets single-user developer machines; the security docs say so. The agent on a remote machine has no listener at all (it speaks over SSH's stdin and stdout).
- Opening the UI from a bookmark of the raw `127.0.0.1` URL breaks after a restart (new port); `https://portplane.localhost` stays stable.

**What would make us revisit it:** moving to a native window without an HTTP listener (ADR-0004).
