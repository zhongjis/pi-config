# herdr-btw

Opens a tool-enabled Pi side thread in a focused [Herdr](https://herdr.dev) pane
without changing the parent transcript — a `/btw` side-question flow that runs in a
separate Pi process and can merge its findings back into the parent.

## Behavior

- Snapshots the parent's current, compaction-aware context.
- Inherits the parent cwd, model, and thinking level by default.
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

`/btw config` shows current defaults; settings persist in Pi's agent directory
(`~/.pi/agent/pi-herdr-btw.json` by default).

```text
/btw config auto-submit on|off
/btw config close-on-exit on|off
/btw config model inherit|provider/model
/btw config thinking inherit|off|minimal|low|medium|high|xhigh|max
/btw config tools inherit|all|read-only|none
/btw config split right|down
/btw config reset
```

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
- Local adaptation: `index.ts`, `src/config.ts`, and `src/core.ts` carry a local patch (closeOnExit config
  flag + PAYLOAD\_VERSION 4→5); `src/context-store.ts`, `src/merge.ts`, `src/router.ts`, and `LICENSE` are
  vendored verbatim. The standalone toolchain and upstream test suite are not vendored.
- Repo-root `pi-herdr-btw.json` provides a committed portable default (autoSubmit+closeOnExit ON),
  symlinked to `~/.pi/agent/pi-herdr-btw.json` by `install.sh`.
  See [AGENTS.md](AGENTS.md) for the full Local Tweaks record.
