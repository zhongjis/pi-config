# better-bash-tool

Overrides the built-in `bash` tool with a `cwd` parameter and native streaming result rendering.

## What It Does

- Adds explicit `cwd` parameter so the agent sets the working directory per-call instead of using `cd && command`
- Prompt guidelines enforce `cwd` usage over `cd` chaining
- Custom call rendering: cwd (shortened with `~`) and any timeout on the header line, with the command on its own indented `$` line below so a long worktree cwd never runs into the command after wrapping
- Native bash result rendering: incremental output streaming, collapsed output preview, expand hint, elapsed/took timing, truncation warnings

## Tools

### `bash`

Execute a bash command in a directory (overrides built-in).

**Parameters:**
- `command` (required): Bash command to execute. Must not start with `cd`.
- `timeout` (optional): Kill command after this many seconds.
- `cwd` (optional): Working directory. Resolves relative paths against context cwd. Fails explicitly if missing.
