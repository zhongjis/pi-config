# icm

Gives Pi the automatic memory lifecycle that [rtk-ai/icm](https://github.com/rtk-ai/icm) provides to other agents through hooks, using the `icm` CLI and its shared SQLite store.

## What It Does

- **Session start:** runs `icm hook start` once per session and adds the wake-up pack as the `icm` system-prompt section on every turn of that session.
- **Each user prompt:** runs `icm hook prompt` with the prompt and adds the recalled context as a hidden `icm-recall` message for that turn.
- **Tool results:** captures every tenth tool output off the turn path. File edits, writes and `icm` CLI calls are skipped.
- **Before compaction:** captures the assistant text being compacted.

In both cases, extraction runs in one of two ways:

- **Pi as provider:** used when `icm config` reports `[extraction] enabled = true` and `[extraction.summarizer] provider = auto`. icm has no Pi provider, and from Pi, `auto` would fall back to the `claude` CLI. Instead, Pi's own model extracts the facts through the `icm.extract` tool key (role `summary.session`, see [tool-model-defaults.ts](../lib/tool-model-defaults.ts)). The extension uses icm's extraction prompt and stores each fact with `icm store -t context-<project>`. It never touches icm's shared queue. The captured text is sent to the resolved model provider unredacted.
- **icm's queue:** used for any other config. The extension queues the text with `icm extract --enqueue`. It drains the queue with a detached `icm extract-pending` after every tenth capture and after every compaction.

The extension is a no-op when `icm` is not on `PATH`. Turn-path calls are bounded by a short timeout; an `icm` failure or timeout only drops that injection or capture.

Failures are written as `panda:debug` session entries and console debug lines when `PANDA_DEBUG=icm` (or `*`) is set; see [lib/logger.ts](../lib/logger.ts).

Hooks, cadence and timeouts are defined in [index.ts](index.ts). The behavior mirrors upstream's [OpenCode plugin](https://github.com/rtk-ai/icm/blob/main/plugins/opencode-icm.ts).

## Configuration

None in Pi; the `icm.extract` model may be overridden in `tool_models.json`. icm reads its own config and `ICM_DB`; storing and recalling memories on demand happens through the `icm` CLI.
