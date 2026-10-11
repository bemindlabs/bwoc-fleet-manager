<div align="center">

# 🌿 BWOC Fleet Manager

**Every BWOC workspace and agent on a machine, in one dashboard.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/bemindlabs/bwoc-fleet-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/bemindlabs/bwoc-fleet-manager/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-339933.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

A Vite + React dashboard over a loopback-only Node sidecar that shells out to the
[`bwoc`](https://github.com/bemindlabs/BWOC-Framework) CLI. Built for the orchestrator's loop:
**survey → route → delegate → report**. The overview answers "where does the fleet need me?", the
workspace view answers "what's wrong here?", and the agent view is where a task actually gets handed
off.

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Configuration](#configuration)
- [What it shows](#what-it-shows)
- [Lifecycle — start · pause · stop](#lifecycle--start--pause--stop)
- [Orchestrator — human need → fleet todos](#orchestrator--human-need--fleet-todos)
- [Groups — Saṅgha teams](#groups--saṅgha-teams)
- [Other actions](#other-actions-all-writes-are-confirmed-first)
- [Docker stack](#docker-stack)
- [Resource Protocol](#resource-protocol)
- [Design notes](#design-notes)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Fleet overview** sorted by what needs attention first (doctor failures → health failures → warnings → backlog)
- **Workspace and agent views** — registry, health signals, inbox, framework skills
- **Lifecycle control** — start / pause / stop one agent, a selection, or a whole workspace
- **Orchestrator** — turn one plain-language need into routed, owned todos
- **Saṅgha teams** — shared task lists with optional plan approval
- **Settings** — check the installed `bwoc` version and run an update
- **Light and dark** themes via `prefers-color-scheme`

## Quick start

```sh
git clone https://github.com/bemindlabs/bwoc-fleet-manager.git
cd bwoc-fleet-manager
pnpm install
pnpm dev          # API on :8791, UI on http://127.0.0.1:5290
```

Production-ish (build once, a single process serves both):

```sh
pnpm build
pnpm preview      # http://127.0.0.1:8791
```

## Requirements

- Node ≥ 20 and [pnpm](https://pnpm.io)
- [`bwoc`](https://github.com/bemindlabs/BWOC-Framework) ≥ 2.33 on `PATH` (needs `--json` on `list` /
  `fleet health` / `doctor` / `sessions` / `tasks` / `status`)

## Configuration

All configuration is by environment variable (see [`.env.example`](.env.example)).

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8791` | API port |
| `BIND_HOST` | `127.0.0.1` | API bind address (keep loopback — see [Security](#security)) |
| `BWOC_BIN` | `bwoc` | Path to the CLI |
| `BWOC_WORKSPACE_ROOT` | `~/Workspaces` | Where workspaces are discovered |
| `BWOC_FRAMEWORK_SRC` | unset | Framework source checkout; used as the skill/plugin catalog and for update checks |
| `SERVE_STATIC` | unset | `1` makes the API serve `dist/` too (used by `pnpm preview`) |
| `BWOC_UPDATE_CMD` | unset | Command the Settings → *bwoc version* **Update** button runs (e.g. a script that pulls, rebuilds and verifies `bwoc`). Unset disables the button; *Check for updates* is always available |
| `BWOC_PLANNER_URL` | unset | Host sidecar URL (`pnpm planner`); enables lifecycle, root agents and the gateway page |
| `BWOC_GW_AGENT` / `BWOC_GW_RELAY` | unset | Gateway mesh identity and relay URL; the mesh stays off until both are set |

Orchestrator settings are listed [below](#orchestrator--human-need--fleet-todos).

## What it shows

**Fleet overview** — totals across every workspace (agents, inbox backlog, running processes,
health warnings, doctor failures), a per-workspace table sorted by *what needs attention first*
(doctor failures → health failures → warnings → backlog), and any directory under the workspace
root that isn't a BWOC workspace at all.

**Workspace** — the agent registry (status, backend, trust tier, inbox depth, age), all 7
Aparihāniya-dhamma health signals with their findings, non-passing `doctor` checks, and installed
framework skills.

**Agent** — identity + trust tier, the full inbox rendered newest-first, and the actions below.

## Lifecycle — start · pause · stop

`bwoc` models two *registry* states (active / stopped) and, orthogonally, whether a
`bwoc-agent --serve` daemon is running. That's three reachable positions, and the three buttons map
to them exactly:

| Button | State reached | CLI |
|---|---|---|
| **Start** | active + daemon running (answers `bwoc ping`) | `bwoc start <a> --yes` |
| **Pause** | active + no daemon (registered, idle) | `bwoc stop` then `bwoc start --yes --no-daemon` |
| **Stop** | stopped + daemon torn down (files kept) | `bwoc stop <a> --yes` |

There is no `pause` verb in the CLI — pausing a *live* agent means tearing the daemon down and
reactivating without one, which is why that row runs two commands. `--yes` is always passed: the
server is not a TTY and the CLI would otherwise block on its prompt.

Every action works on **one agent** (agent view), a **selection** (tick rows in the agent table), or
the **whole workspace** (`--all`, when nothing is selected).

## Orchestrator — human need → fleet todos

The Orchestrate tab turns one plain-language need into routed work. Four phases, which are exactly
the four things a run reports:

| Phase | What happens |
|---|---|
| **PLAN** | `bwoc-harness` decomposes the need against the *live* agent roster — ids, `agentRole` from each manifest, backend, inbox depth — and returns todos with one owner each |
| **COMMIT** | each todo is added to a team's shared task list (optional) and delivered to its owner's inbox with the why + acceptance criteria |
| **EXECUTE** | optional: `bwoc run <agent> --task` per todo, output and exit code captured |
| **REPORT** | **plan** · **output** · **outcome** · **summary** |

- **plan** — the todos, owner, why that owner, and how we'll know it's done
- **output** — raw text each agent produced (only when executed)
- **outcome** — per-phase status plus ok / failed / queued / rejected counts and a per-agent split
- **summary** — the planner's read of the need followed by what actually happened

**Todos routed to an agent that doesn't exist are dropped, not guessed at** — the model will
occasionally invent an owner, and an unowned todo is worse than no todo. Rejects are shown with the
reason rather than hidden.

Three modes, escalating: **plan only** (default, nothing leaves the box) → **plan & dispatch**
(inbox + team list, agents pick the work up themselves) → **+ execute** (each todo is run through
its agent immediately, which spends model time).

Runs are jobs: start one and poll it, because planning against a local model takes minutes. Job
history is in memory and clears on restart.

| Env | Default | Meaning |
|---|---|---|
| `BWOC_HARNESS_BIN` | `bwoc-harness` | Planner binary |
| `BWOC_HARNESS_ENDPOINT` | `http://localhost:11434/v1` | OpenAI-compatible endpoint (Ollama by default) |
| `BWOC_HARNESS_MODEL` | `gemma4:latest` | Planning model |
| `BWOC_PLAN_TIMEOUT_MS` | `300000` | Hard cap on the planning call |
| `BWOC_RUN_TIMEOUT_S` | `900` | Per-todo `bwoc run` timeout |

## Groups — Saṅgha teams

A team is a named subset of agents sharing a task list. The workspace view can:

- **Create** a team from the current table selection (members are validated against the registry
  first — that's how the dangling membership in the pre-existing teams happened)
- **Start / Pause / Stop all** members of a team in one action, skipping members that don't resolve
- **Add tasks** to the shared list, optionally `--requires-plan` (Pavāraṇā: the lead must approve a
  plan before the claimant may complete it)
- **Retire** a team — removes its membership file and task list, leaving the agents untouched

Members shown with a `?` are named in the team file but not registered in this workspace; group
actions skip them and say so.

## Other actions (all writes are confirmed first)

| Action | CLI equivalent | Where |
|---|---|---|
| Send a task to an inbox | `bwoc send <agent> "<task>"` | Agent view |
| Liveness check | `bwoc ping --all` | Workspace view |
| Clear stale PID + socket files | `bwoc doctor --auto` | Workspace view (enabled only when something is failing) |

`bwoc retire` is deliberately **not** exposed — destructive lifecycle stays on the CLI, where
succession can be checked first.

## Docker stack

```sh
cp .env.example .env
openssl rand -hex 32                # paste into BWOC_A2A_TOKEN
docker compose up -d
docker compose --profile agents up -d   # + the agent daemon / gateway bridge
```

The compose project is named `fleet-manager` (override with `COMPOSE_PROJECT_NAME`).

| Service | Port (loopback) | What it is |
|---|---|---|
| `fleet-manager` | 8791 | this dashboard, UI + API in one process |
| `mosquitto` | 1883, 9001 (ws) | the MQTT broker `bwoc-mqtt` talks to — bwoc ships a client, not a broker |
| `mqtt-bridge` | — | `bwoc-mqtt serve`, subscribes `bwoc/+/inbox` and appends each envelope to the matching agent's `inbox.jsonl` |
| `a2a` | 41241 | `bwoc-a2a serve` — Agent Card discovery + JSON-RPC inbound |
| `agentd` | — | `bwoc-agent --serve` (profile `agents`). It spawns `bwoc-gateway-recv` itself when an agent's `interconnect/gateway.toml` sets `enabled = true`, so the relay is configured per agent, not here |

**The host `bwoc` binary cannot be reused.** On a macOS arm64 host it is a Mach-O binary. The images install
`bwoc`, `bwoc-agent` and `bwoc-harness` from the framework's Linux release tarball
(`BWOC_RELEASE`, checked against the release `.sha256`). The release does not ship `bwoc-mqtt` or
`bwoc-a2a`, so the `transport` image still compiles those two from the named build context
`bwocsrc` (`BWOC_SRC`, default `../BWOC-Framework-build`); that build is slow the first time and
cached afterwards. Keep the `BWOC_SRC` checkout at the same tag as `BWOC_RELEASE` — it is also the
Settings catalog, so a stale checkout shows skills and plugins that the release no longer has.

`~/Workspaces` is bind-mounted read-write into every service, since the transports append to
inboxes and the manager flips registry state.

> **Host/container split.** Agents started *inside* a container are container processes. Their PID
> files land in the shared workspace but refer to PIDs the host can't see, so a host-side
> `bwoc doctor` will call them stale. Drive lifecycle from one side or the other — not both.

Ports publish to `127.0.0.1` only. The A2A listener additionally refuses a non-loopback bind
without `BWOC_A2A_TOKEN`, which is why compose treats it as required.

## Resource Protocol

The fleet can share compute across hosts (BWOC Resource Protocol, 2.39+). Example roles:

| Host | Role | State |
|---|---|---|
| a laptop | consumer | `bwoc resource snapshot` works; no GPU, and RAM reads `/proc` so it is Linux-only — this host borrows, it does not offer |
| a GPU server | provider | e.g. one 46 GB GPU / 128 cores / 128 GB RAM, `share = true` with caps (say 32 GB VRAM · 64 GB RAM · 64 cores · 2 leases) |
| any host `:10601` | broker | `bwoc-relay` container running `bwoc-gateway` |

Provider config lives in that host's `.bwoc/workspace.toml` under `[resource]` — refuse-by-default,
so nothing is shared until `share = true`. Verify the gate without touching the network:

```sh
bwoc resource gate-check --kind compute --from <agent> --gpu-vram 16000 --ram 8000 --cores 8
# ALLOW / DENY (over_cap) / DENY (kind_not_offered) / DENY (not_sharing) …
```

**Slice status matters:** A–C shipped (snapshot, gate-check, advertise/discover, broker discovery
half). **claim/lease and offload are slice D and not shipped** — so the working end state today is
*discovery* (seeing that a server has 40 GB of GPU memory free), not *borrowing*.

## Design notes

- **Loopback is the security boundary.** The API binds `127.0.0.1` and has no auth, because it can
  write to inboxes and change agent state. Never put it behind a public reverse proxy or bind it to
  `0.0.0.0`.
- **No shell interpolation.** Every CLI call goes through `execFile` with an argv array, and
  workspace/agent names are resolved against the discovered fleet before use — a name that isn't in
  the registry gets a 404 rather than reaching a subprocess.
- **Agent id ≠ directory name.** The registry lists `agent-prime` at `agents/prime`, and
  `bwoc --agent` wants the *directory*. The server maps between them so the UI can use ids
  throughout.
- **Non-zero exit is data.** `bwoc doctor` exits 2 when it finds problems; the wrapper keeps stdout
  and reports the findings instead of treating it as a crash.
- **4s response cache + 6-way concurrency cap.** A refresh fans out to ~30 CLI invocations across
  10 workspaces; without both, polling would stampede the machine.
- **Full-width layout, no `max-width` caps** — the fleet table wants every pixel. Light and dark
  both supported via `prefers-color-scheme`.

## Security

The API has no authentication — its reachability is the security boundary. Keep it on loopback
(or a private network such as a tailnet) and never expose it publicly. To report a vulnerability,
see [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) first. Notable changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).
