# Readonly Bash

Restricted shell tool for read-only commands. Validates commands against an allowlist before execution. Best-effort accidental-mutation guard, not a security sandbox.

## Tool

`readonly_bash` — executes a validated read-only shell command.

Parameters:

- `command` (required) — the shell command to run
- `timeout` (optional) — execution timeout in seconds

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
- **Kubernetes (read-only):** `kubectl get`, `describe`, `logs`, `explain`, `api-resources`, `api-versions`, `version`, `top`, `events`, `options`
- **Flux (read-only):** `flux get`, `logs`, `stats`, `tree`, `trace`, `events`, `version`, `check`, `export`

Read-only cluster commands can still expose Secrets, ConfigMaps, logs, events, node metadata, and any RBAC-visible resources. This extension is not a confidentiality sandbox.

## Rejected

- Pipes, chaining (`&&`, `||`, `;`), redirection (`>`, `>>`)
- Command/process substitution (`$(...)`, backticks)
- `xargs`, `sudo`
- Mutating commands (`rm`, `mv`, `cp`, `mkdir`, `chmod`, `chown`, `touch`)
- Mutating git (`add`, `commit`, `push`, `checkout`, `rebase`, `merge`, `reset`)
- Mutating kubectl (`apply`, `delete`, `patch`, `exec`, `port-forward`, `config`, `auth`)
- Mutating flux (`bootstrap`, `reconcile`, `create`, `delete`, `suspend`, `resume`)
- Package managers (`npm`, `pip`, `brew`, `apt`)
- Nix build/develop/run
- Script interpreters (`python`, `node`, `bash`, `sh`)
