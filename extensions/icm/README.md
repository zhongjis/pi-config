# icm

Gives Pi the automatic memory lifecycle that [rtk-ai/icm](https://github.com/rtk-ai/icm) provides to other agents through hooks, using the `icm` CLI and its shared SQLite store.

## What It Does

- **Session start:** runs `icm hook start` once per session and adds the wake-up pack as the `icm` system-prompt section on every turn of that session.
- **Each user prompt:** runs `icm hook prompt` with the prompt and adds the recalled context as a hidden `icm-recall` message for that turn.
- **Tool results:** queues every tenth tool output with `icm extract --enqueue` off the turn path, and drains the queue with a detached `icm extract-pending` after every tenth enqueue. File edits, writes and `icm` CLI calls are skipped.
- **Before compaction:** queues the assistant text being compacted and drains the queue in a detached process.

The extension is a no-op when `icm` is not on `PATH`. Turn-path calls are bounded by a short timeout; an `icm` failure or timeout only drops that injection. Extraction uses icm's configured summarizer; the extension never overrides it.

Failures are written as `panda:debug` session entries and console debug lines when `PANDA_DEBUG=icm` (or `*`) is set; see [lib/logger.ts](../lib/logger.ts).

Hooks, cadence and timeouts are defined in [index.ts](index.ts). The behavior mirrors upstream's [OpenCode plugin](https://github.com/rtk-ai/icm/blob/main/plugins/opencode-icm.ts).

## Configuration

None in Pi. icm reads its own config and `ICM_DB`; storing and recalling memories on demand happens through the `icm` CLI.
