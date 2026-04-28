# Extension README Standard

Every extension **must** have a `README.md` in its directory. This is the primary documentation surface for anyone reading, maintaining, or adapting an extension.

## Required Sections

### 1. Title and Summary

```markdown
# extension-name

One-line description of what it does.
```

### 2. Upstream (vendored extensions only)

If the extension is vendored or adapted from an external source, include an **Upstream** section immediately after the summary:

```markdown
## Upstream

- **Source:** https://github.com/org/repo
- **Version:** 0.5.2 (or commit hash)
- **License:** MIT
- **Adapted:** Brief note on what changed from upstream
```

Omit this section for original (non-vendored) extensions.

### 3. Features / What It Does

Describe the extension's behavior. Keep it brief — bullet points or short paragraphs. Group by feature area when the extension does multiple things.

### 4. Tools (if any)

If the extension registers tools visible to the LLM:

```markdown
## Tools

### `tool_name`

Description of what the tool does.

**Parameters:**
- `param1` (required): What it does
- `param2` (optional): What it does
```

### 5. Commands (if any)

If the extension registers slash commands:

```markdown
## Commands

- `/command` — What it does
- `/command <arg>` — What it does with arguments
```

### 6. Hooks (if any)

If the extension hooks into pi lifecycle events (`session_start`, `before_agent_start`, `tool_call`, `context`, etc.), briefly note which hooks and why.

### 7. Configuration (if any)

If the extension has user-configurable settings — config files, environment variables, settings UI, or frontmatter options:

```markdown
## Configuration

### Config file

`~/.pi/agent/foo.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `key` | `string` | `"default"` | What it controls |

### Environment variables

- `FOO_KEY` — Overrides config file value for ...

### Settings UI

`/foo:settings` — Interactive settings editor for ...
```

### 8. Files Worth Reading (optional)

For complex extensions, a quick index of key source files helps maintainers navigate:

```markdown
## Files Worth Reading

- `index.ts` — Extension registration and activation
- `config.ts` — Configuration loading and defaults
- `src/renderer.ts` — Custom tool rendering
```

## What to Omit

- **Implementation details** that only matter to the code itself (internal helper functions, parsing logic, etc.)
- **Duplicated AGENTS.md content** — README is for users/consumers; AGENTS.md is for agents editing the extension
- **Changelog / version history** — use git for that

## Naming

- File is always `README.md` (uppercase)
- Placed at the extension root: `extensions/foo/README.md`

## Examples

See existing READMEs for reference:

- `extensions/caveman/README.md` — vendored extension with levels and upstream sync instructions
- `extensions/subagent/README.md` — complex multi-tool extension with settings
- `extensions/tasks/README.md` — vendored extension with config file and env var documentation
- `extensions/readonly-bash/README.md` — original extension with validation contract docs
