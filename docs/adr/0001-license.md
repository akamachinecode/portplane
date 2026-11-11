# ADR-0001: License the project under Apache-2.0

- **Status:** Accepted
- **Date:** 2026-11-11
- **Resolves:** R1 in [open-questions.md](../open-questions.md)

## What it has to do

Portplane is a developer tool that people install on their own machines, next to dekit and portless. The license has to:

- let anyone install it at work without a legal review getting in the way;
- let other projects reuse parts of it, such as the collector or the adapters;
- welcome outside contributions without a contributor license agreement (CLA);
- sit comfortably next to the licenses of the tools it builds on and the libraries it is likely to use.

Portplane is not a hosted service. Nobody can run it "as a service" for other people, so protection against closed SaaS forks is worth little here.

## Criteria

| Criterion | Weight | Why |
|---|---|---|
| Adoption at work | High | A dev tool spreads one developer at a time; copyleft licenses are often blocked or delayed by company policies |
| Patent protection | Medium | An explicit patent grant protects users and contributors |
| Compatibility with dependencies | High | dekit is MIT, portless is Apache-2.0, gopsutil is BSD-3-Clause, Wails is MIT |
| Keeping improvements open | Low | No hosted use case; the value of the project is in its maintenance, not its code alone |
| Contribution friction | Medium | DCO sign-off only, no CLA |

## Options

| Option | Adoption | Patents | Compatibility | Keeps improvements open |
|---|---|---|---|---|
| **Apache-2.0** | Very good | Explicit grant and retaliation clause | Same as portless; MIT and BSD dependencies are compatible | No |
| MIT | Very good | None explicit | Same as dekit; everything compatible | No |
| AGPL-3.0 (as Exhale) | Often blocked at work | Yes (via GPLv3) | Compatible with the permissive dependencies, but limits who can reuse Portplane's code | Yes, also over a network |
| MPL-2.0 | Good | Yes | Compatible | Per file only |

## Verdict

**Apache-2.0.** It is as easy to adopt as MIT, adds an explicit patent grant, and matches portless, the tool Portplane depends on most closely. Contributions are accepted under the same license through the Developer Certificate of Origin (`git commit -s`); there is no CLA.

**Cost we accept:** anyone can ship a closed-source fork. For a local developer tool with no hosted form, we judge that risk small.

**What would make us revisit it:** a hosted or team-shared form of Portplane appears, or a dependency we cannot do without turns out to require a different license.
