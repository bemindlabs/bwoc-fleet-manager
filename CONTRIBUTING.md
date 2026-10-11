# Contributing to BWOC Fleet Manager

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/bemindlabs/bwoc-fleet-manager/issues) first.
- Open a new issue using the **Bug report** or **Feature request** template.
- **Security problems are not issues** — follow [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node ≥ 20, [pnpm](https://pnpm.io), and the [`bwoc`](https://github.com/bemindlabs/BWOC-Framework) CLI (≥ 2.33) on `PATH`.

```sh
pnpm install
pnpm dev          # API :8791 · UI http://127.0.0.1:5290 · planner sidecar
```

Useful scripts:

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc -b --noEmit` |
| `pnpm build` | type-check and build the UI into `dist/` |
| `pnpm preview` | serve the built UI + API from one process |

Please make sure `pnpm typecheck` and `pnpm build` pass before opening a PR (CI runs both).

## Pull requests

1. Fork the repo and create a branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep changes focused — one concern per PR. Match the surrounding code style.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and the PR title
   (e.g. `fix(ui): …`, `feat(server): …`).
4. Update the README / `.env.example` when you add configuration, and add a line under
   **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
5. Fill in the pull request template.

### Ground rules for server code

- Call the CLI only through `execFile` with an argv array — never build shell strings from input.
- Resolve workspace and agent names against the discovered fleet before using them.
- Writes must stay behind the `x-fleet-manager` header check and be confirmed in the UI.
- Do not add defaults that point at a specific host, user or network.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), as described in section 5 of that license.
