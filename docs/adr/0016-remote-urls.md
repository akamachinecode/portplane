# ADR-0016: Open remote apps at `https://<app>.<machine>.localhost` through an HTTP proxy per app

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** A5 in [open-questions.md](../open-questions.md)

## What it has to do

A remote app's `https://web.shop.localhost` resolves to the remote machine's own loopback, not to the laptop. Clicking it in Portplane must open the remote app, at a URL that stays the same across restarts, without exposing anything on the network.

## Options

1. **Raw TCP forward** of the app's port to a local port. Simple, but the browser sends `Host: <local name>`, which some dev servers reject or use to build absolute URLs.
2. **HTTP reverse proxy per app** on loopback, dialling through the agent (ADR-0015) and presenting the remote app's own hostname. Handles WebSocket upgrades (hot reload).
3. **Forward the remote portless proxy (443)** and route by name: one forward, but TLS is terminated remotely for a name the laptop does not trust.

## Verdict

**Option 2.** For every remote app that is on, the app opens a loopback listener and a reverse proxy that:

- dials the app's port on the remote machine through the agent;
- sends the remote hostname (`web.shop.localhost`) as `Host`, and rewrites `Origin` and `Location` between the local and the remote name;
- is registered with portless as `<remote name>.<machine>`, so the app is at `https://web.shop.box.localhost` with the local trusted certificate. Without portless, the URL is `http://127.0.0.1:<port>`.

The alias name depends only on the remote app's name and the machine, so it survives restarts and port changes. Forwards close and aliases are removed when the app stops, the machine goes offline or Portplane quits. Any other remote port can be opened on demand the same way.

Checked end to end on 2026-11-11 over real SSH: a portless-wrapped app on the remote side was served at `https://acme.box.localhost` with status 200. portless reloads its routes shortly after `portless alias` returns, so Portplane waits until the proxy serves the new name before showing the URL.

**Cost we accept:** apps that set cookies for a parent domain (`shop.localhost`) do not get them under `box.localhost`; cross-subdomain logins on remote apps may need the cookie domain adjusted. Non-HTTP ports (databases) are not forwarded in v1.

**What would make us revisit it:** demand for TCP forwarding of databases, or portless gaining remote routes natively.
