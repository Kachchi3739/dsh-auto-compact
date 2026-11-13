# dsh-auto-compact

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that adds `/auto-compact`:
**compact a conversation automatically once its context reaches a level you choose.**

The shipped `/compact` compacts once, when you ask. `/auto-compact` keeps a threshold and
compacts on its own after a turn, so long sessions stay manageable without manual work.

Default **500,000** tokens · allowed **100,000 – 1,000,000**.

[한국어 문서](README_ko.md)

## Install

This repository is a DSH bundle (`package.json` → `dsh.bundle.patch` → `cordis.patch.yml`).
Install it from GitHub:

```
plugin_manager install_bundle target=github:Kachchi3739/dsh-auto-compact#main
```

Pin the release instead:

```
plugin_manager install_bundle target=github:Kachchi3739/dsh-auto-compact#v1.0.0
```

For local development, install from the checkout directory:

```
plugin_manager install_bundle target=<absolute path to this directory>
```

The bundle registers the Host-plane row `auto-compact` (package `@local/auto-compact`).
The command is attached to live Agents, so it works in existing Sessions as well as new ones.

## Usage

| Input | Result |
|---|---|
| `/auto-compact` | Show the current state, level, and measured context. |
| `/auto-compact 500k` | Set the level to 500,000 tokens and turn auto-compact on. |
| `/auto-compact on` / `off` | Turn automatic compaction on or off without changing the level. |
| `/auto-compact reset` | Restore the default level (500,000) and turn auto-compact on. |
| `/auto-compact status` | Same as the argument-free form. |

Levels accept a plain count (`500000`) or `k`/`m` suffixes (`500k`, `0.5m`, `1M`), with optional
comma, underscore, or space separators. Values outside **100,000 – 1,000,000** are clamped to the
nearest limit and the command says so.

## How it works

- **Trigger.** When a turn closes the Agent reports `idle`; the plugin measures that Session's
  request-and-surface context with `ctx.tokenMeter.measure()` and compacts when the measurement is
  at least the threshold. It tries once per idle transition and never loops on one idle window.
- **Engine.** It calls `compaction.compactNow(agent, signal)` — the exact manual-compaction path
  `/compact` uses, so checkpoints and shadowed history records are identical. Any mounted compaction
  backend works.
- **It never delays you.** If a queued message starts the next turn first, the check is skipped and
  the next idle transition tries again.
- **Failures stay in logs.** Automatic compaction errors are Host diagnostics (`auto-compact: …`),
  not UI errors; the Session log already records failed attempts.
- **Not model-facing.** Nothing here enters model history; a successful compaction replaces older
  history with the backend's summary checkpoint.

## Placement

This is a **Host-plane** plugin. The Web surface disables the host-plane `compaction-basic` and
`command-compact` rows and mounts them inside each agent preset's isolated `cordis:group`, so a Host
row cannot `inject` the `compaction` service. The plugin instead

- registers one **agent-scoped** `/auto-compact` command per live Agent through that Agent's own
  context (`agent.ctx.commands.register`), so the command belongs to exactly that Agent;
- resolves the engine with `ctx.agentPresets.serviceFor(agent, 'compaction')` — the documented
  accessor for services inside a preset's isolation realm — falling back to the host-plane
  `compaction` service for compositions without presets (CLI/TUI);
- watches `agent/created`, `agent/status`, and `agent/disposed` from the Host plane, which is
  unscoped and therefore serves every Agent regardless of preset.

Requires the `agents`, `commands`, and `tokenMeter` Host services.

## Persistence

The chosen level lives in a plugin-owned file under the active profile:

```text
<profile>/.auto-compact/state.json
```

```json
{ "version": 1, "enabled": true, "thresholdTokens": 500000 }
```

Writes are atomic (temporary file + rename) and serialized. A missing file means the row config
defaults apply; an unreadable or invalid file is logged and ignored instead of failing activation.
Without a profile context the plugin falls back to `$DSH_HOME/auto-compact/state.json`. The row
config (`enabled`, `thresholdTokens`) is only the fallback default and is validated strictly at
activation.

## Notes

- The threshold is **per profile**, not per Session: every Agent served by this plugin shares it.
- Subagent and teammate Agents are live Agents too, and are measured the same way.
- The threshold is an absolute token count. If a model's context window is smaller than the level,
  the shipped 80%-of-window pressure compaction still protects the request first; the status output
  warns when that ordering applies.
- Measurement is replay-based and heuristic for text the provider did not price, so the trigger
  point is approximately the level, not an exact billing count.

## Development

```sh
npm test          # node --test --test-isolation=none "test/**/*.test.mjs"
```

`policy.js` is the pure layer (parsing, bounds, validation, formatting, state document) with no
imports. `index.js` wires it to the Agent registry, the per-Agent command registry, the
preset-scoped compaction seam, and the profile state file.

## License

MIT
