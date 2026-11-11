# Contributing to Portplane

Thanks for helping! Portplane shows every local dev server, on every machine, in one window, on top of [dekit](https://dekit.run) and [portless](https://github.com/vercel-labs/portless).

The project is in its **design phase**: there is no product code yet. The most useful contributions right now are:

- comments on the [vision](docs/vision.md), the [open questions](docs/open-questions.md) and the [roadmap](docs/roadmap.md);
- new [field notes](docs/field-notes.md): a dev server, framework or setup that broke when wired to dekit and portless, and what fixed it;
- testing the [prototype](prototype/README.md) and reporting what it gets wrong.

## Decisions

Every significant technical decision is an ADR in [docs/adr](docs/adr/README.md). Read the relevant ADR before proposing a change to it. To change an accepted decision, open an issue first; if it is agreed, a new ADR supersedes the old one.

## Rules

- **Everything is public and in English.** Never include names of clients, employers, private projects, hostnames or personal paths. Use generic examples (`web`, `api`, `my-monorepo`).
- **No forks of dekit or portless.** If Portplane needs something they lack, propose it upstream.

## Commits and pull requests

- PR titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(collector): …`, `fix(ui): …`, `docs: …`). PRs are squash-merged, so the title becomes the commit and the changelog entry.
- Sign off every commit (`git commit -s`): it certifies the [Developer Certificate of Origin](https://developercertificate.org/). The project is licensed under [Apache-2.0](LICENSE); there is no CLA.
- Keep PRs focused. Discuss larger changes in an issue or a Discussion first.
