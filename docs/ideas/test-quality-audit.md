# Test Quality Audit

Status: idea

## Decision frame

This audit applies the repository testing policy and the ponytail rule: keep the smallest test that proves an observable contract. Prefer real objects, then focused in-memory fakes, then mocks only at an impractical boundary. A mock count is a hotspot signal, not a quality score.

The supplied article reports that coding agents used mocks in 36% of test-modifying commits versus 26% for non-agent commits.[1] Its linked study warns that mock-heavy generated tests may be easier to produce while validating fewer real interactions.[2] Neither source validates universal limits such as “three mocks per file.” Test-double roles also differ: a fake implements working behavior, a stub returns canned data, a spy records calls, and a mock encodes expected interactions.[3]

## Repository evidence

The 2026-05-02 inventory found:

- 243 TypeScript test files;
- 53,190 test lines versus 57,040 non-test TypeScript lines in the inspected paths;
- 60 test files over 250 physical lines;
- 131 files containing mock-related syntax, including harmless theme functions and justified process/provider boundaries;
- 3,229 passing tests, 4 skipped tests, and 5 failures in the captured full-suite run.

The five failures were two classifier call-count assertions, two real-TUI theme mismatches (`theme.bg` absent), and one exact tool-registry smoke-test timeout. Those failures are baseline evidence, not proof that the tests should be deleted.

## Findings

### Delete tests with no durable behavior

1. `extensions/modes/test/config-loader.test.ts` has a compile-only `overlays` assignment test. TypeScript already proves it.
2. `test/weizheng-removal.test.ts` and the retired-marketplace assertion in `test/extensions.smoke.test.ts` preserve deletion tombstones. Git records those removals.
3. `extensions/profiles/profiles.test.ts` labels a test “multiple independent filter owners” without registering a second owner; existing lifecycle tests cover the actual behavior.
4. `extensions/qol/test/header.test.ts` checks the exact handler-key array although later tests execute both handlers.
5. `extensions/qol/test/exit.test.ts` pins command copy. Registration and one shutdown call are the behavior.

### Replace prose and interaction assertions with contracts

1. `extensions/goal/test/extension.test.ts` pins complete natural-language tool and parameter descriptions. Keep names, schemas, required fields, and variants.
2. `extensions/smart-tool-guards/test/classifier.test.ts` pins the complete classifier prompt and full provider invocation. Keep trusted-policy/untrusted-payload separation, schema, selected model options, and parsed verdict behavior.
3. `extensions/inline-skills/test/inline-skills.test.ts` mutates `CustomEditor.prototype` and asserts one internal callback. Prefer autocomplete behavior after reload; delete the test if no public seam can prove it without reproducing editor internals.
4. `extensions/modes/test/commands.test.ts`, `extensions/smart-sessions/test/index.test.ts`, and `extensions/handoff/test/index.test.ts` contain repeated call-count, call-argument, and notification-fragment assertions. Retain only interactions that are themselves public boundaries; otherwise assert resulting mode/model, session state, editor content, or tool result.

### Consolidate duplicate cases

1. Profile shortcut tests repeat profile switching and registry filtering already covered by the main command path.
2. Ask normalization and state tests repeat ordinary short-label and movement bookkeeping around stronger boundary cases.
3. QoL write-renderer tests repeat the same width loop for equivalent rendering branches.
4. Clauderock model fallback tests repeat equivalent mappings that fit one table.

### Deepen the subagent runner seam

`extensions/subagents/test/agent-runner.test.ts` replaces the SDK, config loader, environment detector, prompt builder, and skill loader, then implements a simulated session and resource loader. This can remain green while the real SDK contract changes. `tool-scope-characterization.test.ts` requires several local module mocks to reach one exported function.

The subagent owner should retain narrow policy units, move SDK lifecycle and binding behavior to the existing real-runtime harness, and give live tool-scope narrowing a focused module tested with the real `computeActiveToolNames` and one small stateful session fake. This work is coordinated separately because another session owns `extensions/subagents/**` on the shared branch.

### Keep realistic boundary coverage

Keep the tests that exercise:

- temporary filesystem persistence and migration;
- process, provider, clock, randomness, and terminal boundaries where real execution is impractical;
- graph restore security, checkpoint durability, cancellation, and lifecycle behavior;
- real-runtime integration sessions;
- model-selection precedence with distinct fixtures;
- GitHub view resolution and cache materialization;
- event-bus registration, cleanup, ordering, and failure isolation.

## Refactor sequence

1. Delete zero-value and misleading tests without replacement.
2. Remove prose/copy assertions while retaining machine-consumed schemas, tags, fields, and routing decisions.
3. Consolidate duplicate cases without changing production behavior.
4. Deepen over-mocked seams only where a smaller real/fake test replaces the mocks.
5. Split an oversized test file only when it is already being changed, and split by behavior rather than line count.
6. Run each owner’s focused unit suite, the TypeScript no-excuse checker, typecheck, and then broad unit/integration checks.

## Non-goals

- Do not impose a repository-wide mock-count threshold.
- Do not replace lightweight fakes with containers or new dependencies absent a concrete integration risk.
- Do not rewrite strong security, persistence, or concurrency tests merely because they use doubles.
- Do not change production behavior as part of this test cleanup.

## Sources

[1] Daniel Vaughan, “The Over-Mocking Problem” (https://codex.danielvaughan.com/2026/05/02/over-mocked-tests-agent-generated-test-quality-codex-cli-realistic-testing/)

[2] Hora and Robbes, “Are Coding Agents Generating Over-Mocked Tests?” (https://arxiv.org/abs/2602.00409)

[3] Martin Fowler, “Test Double” (https://martinfowler.com/bliki/TestDouble.html)
