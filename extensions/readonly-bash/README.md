# Readonly Bash

Restricted shell tool for read-only commands. Validates commands against an allowlist before execution. Best-effort accidental-mutation guard, not a security sandbox.

## Status

Deprecated for Fu Xi only: Fu Xi now uses smart-guarded built-in `bash`. `readonly_bash` remains implemented and enabled for five read-only subagents: `chengfeng`, `direnjie`, `taishang`, `xuannv`, and `yanluo`.

## Tool

`readonly_bash` — executes a validated read-only shell command.

Parameters:

- `command` (required) — the shell command to run
- `timeout` (optional) — execution timeout in seconds

- Streams output incrementally through Pi's native bash result renderer
## Registration

Registered globally but disabled by default. Enable per-agent via frontmatter:

```yaml
extensions: readonly_bash
```

## Allowed Commands

- **Navigation:** `pwd`, `ls`, `find` (no `-exec`), `fd`
- **Search:** `rg`, `grep`, `git grep`
- **File reading:** `cat`, `head`, `tail`, `sed -n`, read-only `awk`
- **Data processing:** `jq`, `wc`, `sort`, `uniq`, `cut`
- **File info:** `file`, `stat`, `du`, `df`
- **Git (read-only):** `status`, `log`, `diff`, `show`, `branch`, `rev-parse`, `grep`
- **GitHub (read-only):** `gh search repos`, `search code`, `search issues`, `search prs`, `gh repo view`, `repo list`, `gh issue view`, `issue list`, `issue status`
- **Kubernetes (read-only):** `kubectl get`, `describe`, `logs`, `explain`, `api-resources`, `api-versions`, `version`, `top`, `events`, `options`
- **Flux (read-only):** `flux get`, `logs`, `stats`, `tree`, `trace`, `events`, `version`, `check`, `export`

Read-only cluster commands can still expose Secrets, ConfigMaps, logs, events, node metadata, and any RBAC-visible resources. This extension is not a confidentiality sandbox.

## Composition

- A single pipe (`|`) chain of read-only commands is allowed; every stage is validated independently (e.g. `git show --stat HEAD | head -60`, `rg foo . | sort | uniq -c`).
- Redirection is rejected **except** to `/dev/null` (e.g. `git show HEAD 2>/dev/null`), which is stripped before validation.
- Any pipe stage that fails the allowlist rejects the whole command.

## Rejected

- Chaining (`&&`, `||`, `;`), backgrounding (`&`), redirection to anything other than `/dev/null`
- Command/process substitution (`$(...)`, backticks)
- `xargs`, `sudo`
- Mutating commands (`rm`, `mv`, `cp`, `mkdir`, `chmod`, `chown`, `touch`)
- Mutating git (`add`, `commit`, `push`, `checkout`, `rebase`, `merge`, `reset`)
- Mutating or broad GitHub CLI commands (`gh auth`, `api`, `pr`, `workflow`, `repo clone/create/delete/edit/fork/sync`, `issue create/edit/close/comment/delete/transfer`)
- Mutating kubectl (`apply`, `delete`, `patch`, `exec`, `port-forward`, `config`, `auth`)
- Mutating flux (`bootstrap`, `reconcile`, `create`, `delete`, `suspend`, `resume`)
- Package managers (`npm`, `pip`, `brew`, `apt`)
- Nix build/develop/run
- Script interpreters (`python`, `node`, `bash`, `sh`)
