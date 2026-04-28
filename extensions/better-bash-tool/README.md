# better-bash-tool

Overrides the built-in `bash` tool with a `cwd` parameter and improved rendering.

## What It Does

- Adds explicit `cwd` parameter so the agent sets the working directory per-call instead of using `cd && command`
- Prompt guidelines enforce `cwd` usage over `cd` chaining
- Custom call rendering: shows cwd (shortened with `~`) above the command, with timeout suffix
- Custom result rendering: exit code status (✓/✗), line count, collapsed output preview (last 5 visual lines), expand hint, truncation warnings

## Tools

### `bash`

Execute a bash command in a directory (overrides built-in).

**Parameters:**
- `command` (required): Bash command to execute. Must not start with `cd`.
- `timeout` (optional): Kill command after this many seconds.
- `cwd` (optional): Working directory. Resolves relative paths against context cwd. Fails explicitly if missing.
