# smart-tool-guards

Guards selected built-in `bash` calls with deterministic policy checks and a fail-closed model classifier while preserving native execution semantics.

## Scope

| Caller | Built-in `bash` behavior |
|---|---|
| Fu Xi mode | Guarded when the latest active mode is `fuxi`; missing guard capability blocks execution. |
| `chengfeng`, `direnjie`, `taishang`, `xuannv`, `yanluo` | Guarded by a trusted hidden subagent factory, including when ordinary extensions are disabled, isolated, or filtered. |
| Other modes and agents | Scope providers abstain; smart-tool-guards does not alter the call. |
| Non-`bash` tools | Always bypassed. |

Scope providers return `"abstain"` or `{ decision: "guard", reason }`. Evaluation returns a discriminated abstain, guard, or error result; active scopes and failed provider IDs are sorted. Error outranks guard, guard outranks abstain, and thrown, malformed, or blank-reason decisions are provider errors. Duplicate IDs retain latest-provider replacement semantics.

## Denial Messages

Every guarded denial has this two-line envelope:

```text
[Smart Guard][BLOCK|ERROR][source=<source>][profile=bash-read-only-v1][scope=<sorted provider IDs>]
Bash not run: <detail>[ Guard active: <successful provider activation reason(s)>]
```

`scope=none` is used only when no provider ID is available. `Guard active:` is appended only for successfully active provider scopes, so a scope-only error relies on its fail-closed detail. Dynamic classifier and provider reason whitespace is normalized to one line. `smart-tool-guards` alone formats messages; providers supply structured scope and activation reasons.

Categories are stable: deterministic findings are `BLOCK/source=policy`, valid classifier denials are `BLOCK/source=classifier`, malformed input is `ERROR/source=input`, classifier unavailability is `ERROR/source=classifier`, and scope evaluation failure is `ERROR/source=scope`. Policy details name read-only policy finding codes without calling the command dangerous. Scope errors identify failed provider IDs and explain fail-closed behavior without exposing provider errors.

## Bash Policy

Guarded calls use this precedence:

1. Invalid `command`, `cwd`, or `timeout` input blocks.
2. Deterministic policy findings block before model use, with stable finding codes for filesystem, VCS, external-system, privilege/system-control, redirection, shell/interpreter, downloaded-code, and uninspectable-syntax hazards.
3. Exact trimmed `pwd` and exact single-command, read-only `agent-browser` forms allow without a classifier call. The browser allowlist covers page inspection, runtime and metadata reads, documented output-only flags and filters, and help/version queries; URL reads, effectful waits, mutating siblings, wrappers, pipelines, and compound commands are excluded.
4. Every other command defers to the classifier.

The guard never rewrites input. Allowed calls continue through Pi's native `bash` executor with the original command, requested `cwd`, and requested `timeout`. Classifier context includes the requested values plus an effective cwd resolved from the session cwd; omitted timeout remains omitted. Caller cancellation and the classifier's own five-second decision deadline both abort the nested model request, independently of native execution timeout.

## Classifier Contract

Model selection resolves `smart-tool-guards.classifier` from layered `tool_models.json` config. Its built-in role is `guard.tool`. When no model in that chain is available or authenticated, the classifier falls back to the current session model so an unavailable guard chain does not hard-block every guarded call; the chain is still preferred whenever one of its models resolves.

Trusted policy instructions stay in the system prompt. The command and context are serialized only as an untrusted JSON user payload. A valid response is exactly one of:

```json
{"version":1,"decision":"allow"}
```

```json
{"version":1,"decision":"block","reason":"nonblank explanation"}
```

Provider thinking blocks are ignored when accompanied by a text verdict. Markdown fences, extra keys, blank block reasons, thinking-only or tool-call/unknown content, non-stop completion, or any other shape are invalid.

## Failure Semantics

Guarded execution fails closed. Scope-provider failure, malformed input, and deterministic policy findings block before any model use. A valid classifier block also blocks and is never downgraded by a later candidate. The classifier tries each model candidate in order — the resolved `guard.tool` chain, then the current session model — and skips a candidate whenever it cannot produce a valid verdict (missing/unauthenticated model, transport or provider error, timeout or cancellation, or a malformed verdict), advancing to the next. Only when no candidate yields a verdict does it return the stable `ERROR/source=classifier` denial without exposing raw model or provider errors.

This is an authorization guard, not a shell sandbox or security boundary. Allowed shell commands retain native shell power.

Repository changes do not update an existing live Pi process. After this migration is accepted, the user must run `bash install.sh` later and restart Pi; that install links `smart-tool-guards` and removes stale repo-owned extension symlinks. Do not run both old and new extension copies in one process.
