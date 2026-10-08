# herdr-btw

Opens a tool-enabled Pi side thread in a focused [Herdr](https://herdr.dev) pane
without changing the parent transcript — a `/btw` side-question flow that runs in a
separate Pi process and can merge its findings back into the parent.

## Behavior

- Snapshots the parent's current, compaction-aware context.
- Inherits the parent cwd, model, and thinking level by default.
- Inherit tools preserve registered availability and the parent's exact initial active selection; inactive tools remain available for later lazy activation.
- Prefills the question for review by default; leaves the parent session unchanged.
- Stays usable while the parent is working.

## Requirements

- Pi and Herdr v0.7.4+ installed; launches use `herdr pane split` + `herdr agent start --kind pi --pane`.
- Pi running inside a Herdr-managed pane (`/btw` errors otherwise).

## Commands

```text
/btw                      open an empty side pane
/btw <question...>        open a side pane with a draft question
/btw ask <question...>    escape hatch for questions starting with a reserved word
/btw config [...]         show or change defaults
/btw merge <prompt...>    fold this side thread into the parent and continue with the prompt
/btw help                 show the grammar
```

Commands are registered in [`index.ts`](index.ts).

Only the exact first words `ask`, `config`, `merge`, and `help` are subcommands;
anything else is treated as a question.

## Merge

In the side pane, `/btw merge <prompt>` packages the side conversation (user/assistant
turns, no tool payloads) as a transcript, hands it to the parent with your prompt,
refocuses the parent pane, and closes the side pane. The parent appends the transcript
as one visible, context-participating message and auto-submits the prompt. Bare
`/btw merge` opens an editor to compose the prompt. Delivery waits for a busy parent to
settle and survives reloads; an unacknowledged merge outlives the closed pane until the
parent picks it up. In the parent, `/btw merge` rescans for pending requests.

## Config

`/btw config` shows current defaults and sets auto-submit, close-on-exit, model, thinking, tools, and split direction; `/btw config reset` restores defaults. Settings persist in Pi's agent directory (`~/.pi/agent/pi-herdr-btw.json` by default). Keys and defaults are defined in [`src/config.ts`](src/config.ts).

## Prompt cache

When the child inherits the parent's model, tools, and thinking level (the defaults), it
replays the parent's exact system prompt and native messages so prefix-caching providers
(notably Anthropic) can reuse the warm parent cache. Configured model/tool/thinking
overrides are explicit cache-breaking choices; the child then falls back to a portable
flattened snapshot and reports why. OpenAI/gateway cache routing across the new child
session is not guaranteed.

## Caveats

The child receives a static context snapshot and does not see later parent activity; use
`/btw merge <prompt>` to fold the side thread back in. The child shares the working
directory, so enabled tools can modify shared files. Very large parent contexts may
exceed the child's context limit. Launch data lives in a private temporary directory,
removed when the child exits normally (unacknowledged merges are retained until
delivered), and cleaned up after 24 hours if left stale.

## Upstream

- Source: https://github.com/oscabriel/pi-herdr-btw
- Synced version: v0.3.1
- Commit: `679916281e46d4930969183562b5d343df0e968c`
- License: MIT — Copyright (c) 2026 Oscar Gabriel (see [LICENSE](LICENSE))
- Local adaptation: `index.ts`, `src/config.ts`, and `src/core.ts` carry local patches for closeOnExit,
  PAYLOAD\_VERSION 5, and inherit tool availability with one-time initial active selection restoration;
  `src/context-store.ts`, `src/merge.ts`, `src/router.ts`, and `LICENSE` are vendored verbatim.
  The standalone toolchain and upstream test suite are not vendored.
- Repo-root `pi-herdr-btw.json` provides a committed portable default (autoSubmit+closeOnExit ON),
  symlinked to `~/.pi/agent/pi-herdr-btw.json` by `install.sh`.
  See [Local Tweaks](#local-tweaks) for the re-apply checklist and [AGENTS.md](AGENTS.md) for maintenance requirements.

## Local Tweaks

Current divergences from upstream; re-apply each on upstream sync:

- **Patched:** `index.ts`, `src/config.ts`, and `src/core.ts` add a `closeOnExit` config flag (default `false`)
  that auto-closes the child pane on quit, and set `PAYLOAD_VERSION` to 5 for that config field.
- **Patched:** `index.ts` runs the child-side quit cleanup (payload removal, pane close) only in TUI sessions, so UI-less subagent children of a side-thread process leave the pane and payload alone.
- **Patched:** `index.ts` and `src/core.ts` separate registered availability from ordered active names in an optional version-5 `parentAvailableTools` field. Inherit launches allow the registered names through CLI filtering and restore the exact active selection once at startup `resources_discover`, only for TUI children. Reload/resume/new/fork and UI-less descendants do not restore; later activation persists. Legacy payloads retain active-name CLI fallback; cache comparisons remain active-name based.
- **Patched:** `index.ts` fallback `before_agent_start` sets the `herdr_btw` prompt section (`SIDE_PANE_INSTRUCTIONS`) instead of returning a rewritten `systemPrompt`. The `native` cache branch still returns the parent's exact `systemPrompt`; sections would change the cached prefix.
- **Vendored verbatim:** `src/context-store.ts`, `src/merge.ts`, `src/router.ts`, `LICENSE`.
- **Kept with changes:** `tsconfig.json`, with the `test/**` include removed.
- **Not vendored:** `package.json`, `package-lock.json`, `.gitignore`, and the upstream `test/` suite
  (`node:test` via `tsx --test`). This repo relies on root tooling and runs extension tests under
  Vitest with `@earendil-works/*` aliased to stubs.
- **Local tests:** [test/config.test.ts](test/config.test.ts), [test/shutdown.test.ts](test/shutdown.test.ts), and [test/inherit.test.ts](test/inherit.test.ts) cover config, payload validation, shutdown, and inherit launch/lifecycle behavior.
- **Portable default:** repo-root `pi-herdr-btw.json` (autoSubmit and closeOnExit on) is symlinked to
  `~/.pi/agent/pi-herdr-btw.json` by `install.sh`.
