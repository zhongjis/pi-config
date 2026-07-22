# Todo 8 evidence — original race and durable contracts

## End-to-end race
- Real Pi 0.79 runtime loads the registered `Agent` tool and native faux provider through `pi-test-harness`.
- Fixture creates a completed target, runs production cleanup, explicitly restores the same ID, then holds the resumed provider response without sleeps.
- While provider completion is held, the real child session emits successful compaction; `subagents:compacted` is the deterministic checkpoint acknowledgement.
- Parent V1 rows assert `g+1/r0 running -> r1 running checkpoint -> r2 completed terminal`; later delivery revision remains completed/consumed.
- Fresh result appears once in child JSONL; resumed prompt appears once; provider count is exactly 2 total (initial + resumed), tool uses are 0, and no `persistence_failed` is reported.
- Fault variant fails terminal append after r1, returns `failed`/`persistence_failed`, retains fresh output in memory + child JSONL, leaves durable r1 running, and invokes provider exactly once for the resumed generation.

## Contract coverage
- Pi 0.79 deferred first-session flush is normalized before a configured pre-prompt durability barrier; current v3 metadata is written and the same `SessionManager` reopened.
- Live resume characterization now asserts next-generation V1 semantics.
- Foreground pre-prompt persistence failure again reports typed `persistence_failed` before result consumption.
- Active stop requests are idempotent and preserve an existing supervision error; durable stopped candidates replace obsolete internal `result_amended` expectations.
- README, owning AGENTS, and restoration spec document ownership, V1 generation/revision rules, barrier/effect order, execution-vs-durability behavior, recovery matrix, notification at-least-once semantics, Pi 0.79, rollback, and commands.
- Public args/status/reason/event payload/rendering contracts remain unchanged; `subagents:compacted` was added to README's existing event list, not introduced as a new event.

## Verification
- `pnpm exec vitest run --project integration test/integration/subagent-session-restoration.integration.test.ts --reporter=verbose` — PASS (7), FAIL (0).
- `pnpm exec vitest run --project unit extensions/subagent/test/index.session-context.test.ts extensions/subagent/test/regression/finalize-run-parity.test.ts extensions/subagent/test/regression/result-recovery-no-double-abort.test.ts` — PASS (41), FAIL (0).
- `pnpm test:integration` — PASS (62), FAIL (0).
- `pnpm lint:typecheck` — PASS; repo Biome reports pre-existing informational `useLiteralKeys` diagnostics only, all typechecks/subpackage checks pass.
- LSP diagnostics — no errors or warnings in changed TypeScript files; `external-contract-adapter.ts` retains one informational async-conversion hint.
- `rg 'subagents:resume-target-v2|completion_uncommitted|terminal_uncommitted' extensions/subagent/src/types.ts extensions/subagent/README.md docs/specs/subagent-session-restoration.md` — no matches.
- `git diff --check` — PASS.
- `pnpm test:extensions` — PASS (2317), FAIL (0), 178 files.

## F1/F4 repair
- Fresh `AgentManager` runs retain internal running bookkeeping but invoke `onStart` only after `onBeforePrompt` resolves; failed running-V1 append has zero provider calls and zero `subagents:started` callback.
- Live pending-terminal repair now requires an authentication callback before `commitTerminal`. Production re-reads the current durable running target, authenticates its raw prefix, classifies its suffix, and verifies reconstructed output matches the in-memory candidate before repair.
- Manager tests pin authenticate → repair → begin-next-generation → provider ordering and reject authentication failures before terminal commit or provider re-entry.
- Real-runtime terminal-fault coverage now repairs the retained output from authenticated child bytes, then performs exactly one new continuation; each prompt/output and provider execution remains singular.
- README, owning AGENTS, restoration spec, and source comments now state `external-contract-adapter.ts` owns terminal compatibility plus completed/failed effects only; created/started/steered and other event owners remain unchanged.

## DOX
- Updated nearest owner `extensions/subagent/AGENTS.md` and durable user/spec docs.
- Root, `extensions/AGENTS.md`, `docs/AGENTS.md`, and `test/AGENTS.md` indexes/contracts remain accurate; no parent index or ownership boundary changed.
- No V2 schema, dependency upgrade, task/model/UI scope change, public internal status, or runtime-state deletion.
- Path-limited atomic commit contains only listed subagent/docs/integration/task-8 evidence paths; unrelated Hou Tu work and task-7 evidence remain excluded.
