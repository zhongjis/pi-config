# smart-tool-guards

Guards selected built-in `bash` calls with deterministic danger checks and a fail-closed model classifier while preserving native execution semantics.

## Scope

| Caller | Built-in `bash` behavior |
|---|---|
| Fu Xi mode | Guarded when the latest active mode is `fuxi`; missing guard capability blocks execution. |
| `chengfeng`, `direnjie`, `taishang`, `xuannv`, `yanluo` | Guarded by a trusted hidden subagent factory, including when ordinary extensions are disabled, isolated, or filtered. |
| Other modes and agents | Scope providers abstain; smart-tool-guards does not alter the call. |
| Non-`bash` tools | Always bypassed. |

Multiple scope providers compose deterministically: any `guard` decision guards the call, all `abstain` decisions bypass it, and any provider error blocks it.

## Bash Policy

Guarded calls use this precedence:

1. Invalid `command`, `cwd`, or `timeout` input blocks.
2. Deterministic danger blocks before model use, with stable finding codes for filesystem, VCS, external-system, privilege/system-control, redirection, shell/interpreter, downloaded-code, and uninspectable-syntax hazards.
3. Exact trimmed `pwd` allows without a classifier call.
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

Guarded execution fails closed. Scope-provider failure, malformed input, deterministic danger, classifier block, timeout or cancellation, provider failure, and malformed verdict all block before native execution. When the resolved `guard.tool` chain has no available or authenticated model, the classifier falls back to the current session model; only when that fallback model is also missing or unauthenticated does it block. Classifier infrastructure failures collapse to the stable non-leaking reason `Blocked because the bash safety classifier is unavailable.`

This is an authorization guard, not a shell sandbox or security boundary. Allowed shell commands retain native shell power.

Repository changes do not update an existing live Pi process. After this migration is accepted, the user must run `bash install.sh` later and restart Pi; that install links `smart-tool-guards` and removes stale repo-owned extension symlinks. Do not run both old and new extension copies in one process.
