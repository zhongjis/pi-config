---
name: pi-tool-output-presentation
description: Use this skill whenever polishing, designing, reviewing, or debugging Pi tool output presentation for custom tools or extensions. Trigger on requests like "polish tool output", "make collapsed tool results nicer", "add renderCall/renderResult", "TUI summaries", "expanded raw output", "avoid noisy tool results", or when implementing a Pi extension tool whose result is too verbose, confusing, duplicated, or hard to scan. This skill turns real observed tool outputs into compact collapsed summaries while preserving model-visible content and raw expanded output.
disable-model-invocation: true
---

# Pi Tool Output Presentation

Use this skill to improve how Pi tool calls/results appear in the TUI without changing what the model sees.

The core idea: **tool execution output is data for the model; TUI rendering is product UX for the human.** Keep those concerns separate.

## Fit check

Use this workflow when a Pi tool:

- emits long raw text, source code, JSON, symbol lists, diagnostics, search results, or logs;
- has collapsed output that is noisy, unhelpful, duplicated, or indistinguishable from other tools;
- needs custom `renderCall` / `renderResult` behavior;
- should show a short scan-friendly summary while keeping full raw output available on expand.

Do not use this skill for normal CLI stdout formatting unless the request is specifically about Pi tool rendering.

## Before editing

1. Read the applicable repo guidance (`AGENTS.md` chain) for the extension path.
2. If this is a Pi extension, load the `pi-extensions` skill or read the project’s Pi extension docs.
3. Inspect the tool registration: name, label, params, `execute`, result shape, current tests.
4. Identify model-visible fields, usually `result.content` text parts. Treat them as contract.
5. Run or fixture every important operation/output shape before designing summaries.

Avoid guessing from formatter code alone. Real outputs reveal weird cases: empty results, external paths, repeated headers, huge lists, code fences, partial failures.

## Evidence pass: run every output shape

For each tool or operation, capture:

- call args that matter to humans (`query`, `symbol`, `filePath`, `line`, `character`, `projectPath`, etc.);
- success output;
- empty/no-result output;
- error output if easy;
- large/noisy output;
- partial-failure output if the tool can succeed with warnings.

For multi-operation tools, build a quick matrix:

```text
operation            raw shape                 collapsed goal
hover                markdown/code fence        signature + target
diagnostics          counts + grouped details   counts + server failures
references           numbered locations         count + top local paths
workspaceSymbol      symbol list / none         count/query + top symbols
```

Prefer LSP/CodeGraph/real tool calls over invented strings. If a server or daemon is unavailable, use fixtures copied from previously observed raw output.

## Rendering contract

A good Pi tool presentation follows these rules:

1. `renderCall` owns the visible header.
   - Use the full tool name, not a marketing label.
   - Keep args compact and positional when obvious.
   - Example: `▸ lsp · hover · src/a.ts:10:5`.
2. `renderResult` never repeats the tool title.
3. Collapsed `renderResult` uses short `keyword: content` lines.
4. Expanded `renderResult` returns the exact raw text from `result.content`.
5. Never mutate `result.content` to make the UI prettier.
6. Never force global expansion/collapse with `setToolsExpanded`; user/Pi preference owns that.
7. Partial and error states must be safe and short.
8. Renderer failure should not risk hiding raw output; keep parsing simple and defensive.

Recommended collapsed shape:

```text
├─ references: 14 results
├─ matches: src/a.ts:10, src/b.ts:22 +12
└─ app.tools.expand to expand full result
```

For very small results, one summary line plus the expand hint is enough:

```text
├─ diagnostics: clean
└─ app.tools.expand to expand full result
```

Use `keyHint("app.tools.expand", "to expand full result")` when available so keybinding labels follow user config.

## Implementation pattern

Keep render helpers near the tool registration unless they grow too large. Split only after the file becomes hard to scan.

Typical helpers:

- `renderToolCall(args, theme)`.
- `renderToolResult(result, options, theme, context)`.
- `summarizeToolResult(args, text, details)` returning 1–3 `keyword: content` lines.
- tiny parsers for known output headers.

Expanded branch should be first and boring:

```typescript
const text = getResultText(result);
if (options?.expanded) return new Text(text, 0, 0);
```

Then build collapsed details. Prefer stable structured metadata if the tool already returns it. If metadata is missing, parse only stable headers and list prefixes. Do not build a fragile parser for every line of prose.

## Summary design

Design summaries around the user’s question: “Can I tell what happened without expanding?”

Good collapsed lines use `keyword: content`:

- Count: `references: 14 results`
- Domain-specific preview: `matches: src/index.ts:20:7, src/view.ts:44:2 +12`
- Query if not already in header: `query: "Button"`
- Failure note: `server failures: 1`
- Truncation note: `showing: 50 of 132`
- Decisive error: `error: TypeScript Server Error (5.9.3)`

Avoid generic `top:` unless no better domain word exists. Prefer operation-specific keywords:

- references/definitions → `matches: ...`
- symbols → `symbols: Button, ButtonProps, renderButton +9`
- calls → `calls: validate, cleanPath, diagnosticsProgram +25`
- code actions → `actions: Convert named export to default export +3`
- diagnostics → `diagnostics: 2 errors, 1 warning`
- hover → `hover: function registerLspTool(...)`

Omit raw size (`output: 81 lines · 9.4 KB`) by default. Add it only when size itself helps explain why expansion matters.
Bad collapsed lines:

- Repeating the same title as `renderCall`.
- Dumping source code, stack traces, markdown docs, or giant JSON snippets.
- Hiding a partial failure behind “clean” or “success”.
- Listing `node_modules` entries before local project entries.

For location/call lists, prefer local project paths first. External dependency paths are useful, but collapsed view should not let them bury project-relevant results.

## Operation taxonomy

Use this taxonomy as a starting point:

| Output kind            | Collapse to                                                        | Avoid                                         |
| ---------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Search results         | `matches: N`, then `matches: item1, item2 +N`                      | full snippets                                 |
| File tree              | `structure: N files`, root/path/format if not in header            | full tree                                     |
| Diagnostics            | `diagnostics: clean` or counts, failed sources                     | full messages unless first error is the point |
| Hover/docs             | `hover: <signature or first doc line>`                             | whole markdown/code fence                     |
| Definitions/references | `definitions:` / `references:` count, then `matches:` paths        | every location                                |
| Symbols                | `symbols: N`, then `symbols: name1, name2 +N`                      | nested tree                                   |
| Call graph             | `incoming:` / `outgoing:` count, then `calls:` names               | ranges, dependency noise                      |
| Code actions           | `actions: N`, then `actions: preferred/top action +N`              | edit payload/newText                          |
| Build/log output       | `status:` / `error:` decisive line, output size only if meaningful | full logs                                     |
| JSON/API result        | `status:` / `count:` / domain key fields                           | raw JSON                                      |

If an operation has a unique domain concept, name it directly. Example: `impact: 2 symbols`, not generic `items: 2` or `top: ...`.

## Tests

Add renderer tests before calling the work done. Unit tests should prove:

1. `renderCall` includes the full tool name and important args.
2. Collapsed result does not duplicate the title.
3. Expanded result equals raw `content` exactly.
4. Model-visible content remains unchanged.
5. Partial result shows `running` or equivalent.
6. Error result shows first decisive error line and an expand hint.
7. Each important output shape has a representative fixture.
8. Large/noisy output is summarized, not dumped.
9. Local paths outrank dependency paths when both appear.
10. Empty/no-result output is clear.

Renderer test fixtures can use observed raw strings. They do not need live servers unless the repo already has stable integration tests.

## Docs and ownership

After implementation, update docs only at the right level:

- Update extension-local `AGENTS.md` when behavior is a local fork/divergence or sync-preservation detail.
- Update README only when users need to know the behavior exists.
- Avoid bloating root `AGENTS.md`; add a pointer only if the workflow should guide future repo-wide work.

For vendored extensions, record the renderer as a local tweak so future upstream syncs preserve it.

## Verification checklist

Run the smallest checks that prove the renderer works:

```bash
pnpm exec vitest run --project unit path/to/extension/test
pnpm test:extensions
pnpm lint:typecheck
```

Also run diagnostics/type checks on changed files when available.

Report verification with exact commands and results. If a broad check has pre-existing warnings, name them and confirm they predate the change.

## Common traps

- Changing `content` to make collapsed UI nicer. That changes model behavior.
- Implementing a renderer that only works for the happy path.
- Showing a “success” label for partial failures.
- Parsing too much prose instead of adding compact `details` metadata where appropriate.
- Adding global expansion controls. This fights user preference.
- Using label text (`LSP`) when full tool name (`lsp`) is clearer and searchable.
- Letting `renderResult` render a second title under the call header.

## Output when planning

When the user asks for a plan, return:

```text
Current state:
- tools and result shapes

Noisy outputs:
- per tool/operation

Plan:
1. renderCall format
2. collapsed renderResult summaries
3. expanded raw behavior
4. tests
5. docs/AGENTS updates
6. verification commands

Risks:
- parser fragility, missing metadata, live server availability, etc.
```

When the user asks to implement, make the smallest safe change and verify it.
