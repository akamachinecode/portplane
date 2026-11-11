# ADR-0005: Treat the local machine as an agent running in-process

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** the shape of A4 in [open-questions.md](../open-questions.md) (the transport itself is decided in M3)

## What it has to do

M1 shows one machine; M3 adds others over SSH. If the local view is built directly on top of the collector and adapters, M3 has to cut it apart to put a network in between. The question is where the machine boundary sits from day one.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| M3 adds a transport, not a redesign | High | The riskiest milestone should not also be a refactor |
| One code path for local and remote | High | Bugs fixed once; remote behaves like local |
| Local latency | Medium | Local updates must stay instant |

## Options

1. **Direct calls in M1, protocol in M3.** Fastest start, rework later.
2. **Agent interface from M1.** The app (the "hub") only talks to an `Agent` interface. The local agent implements it in-process; in M3, a remote agent implements it by speaking a protocol to `portplane agent --stdio` on the other machine, which wraps the same local agent.
3. **Local agent as a separate process from M1.** Same as 2, plus a real process boundary on the local machine; extra moving parts for no user benefit.

## Verdict

**Option 2.** The agent interface carries plain, JSON-serialisable values:

- `Snapshot()`: the machine's apps, their state, URLs and ports, and other listening ports;
- `Watch()`: a stream of snapshots when something changes;
- `Act(target, verb)`: start, stop or restart an app or project;
- `Excerpt(app)`: the last lines of a failed app;
- `Dial(port)`: a stream to a port on that machine (used by remote URLs in M3).

The hub merges every agent's snapshot into the view and routes actions to the right agent. Nothing outside an agent reads the OS, dekit or portless directly.

**Cost we accept:** an indirection that M1 alone does not need, and types that must stay serialisable.

**What would make us revisit it:** a feature that needs data from two machines at once inside one agent.
