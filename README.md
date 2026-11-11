# Portplane

> Every dev server, on every machine, in one window.

See which local dev servers are running across all your project folders, and across your other machines over SSH. Open them at stable `https://<name>.localhost` URLs, and start or stop them with a click. Built on top of [dekit](https://dekit.run) and [portless](https://github.com/vercel-labs/portless), not instead of them.

**Status:** early development, not ready for daily use yet. The [roadmap](docs/roadmap.md) tracks the way to v1.0. The single-machine prototype that started the project lives in [`prototype/`](prototype/README.md).

## Try it

Portplane reads the `dekit.yaml` files in the folders you give it, and asks [dekit](https://dekit.run) and [portless](https://github.com/vercel-labs/portless) for the live state.

```sh
mise run build                       # from a clone; releases come later
./bin/portplane folders add ~/code   # where your projects (and their dekit.yaml) live
./bin/portplane                      # opens https://portplane.localhost
./bin/portplane ls                   # the same view in the terminal
./bin/portplane restart shop/web     # or start/stop an app or a whole project ("shop/")
```

Without dekit or portless, Portplane still lists the ports open on your machine and the folder each one serves.

## Read more

- [Vision](docs/vision.md)
- [Field notes](docs/field-notes.md): what wiring dekit and portless by hand taught us
- [Open questions](docs/open-questions.md)
- [Roadmap to v1.0](docs/roadmap.md)
- [Architecture decision records](docs/adr/README.md)
- [Upstream proposals](docs/upstream.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
