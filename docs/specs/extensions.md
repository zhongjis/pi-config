# Extension README Standard

Status: shipped

Every extension **must** have a `README.md` in its directory. It is the human entrypoint: what the extension does, how to start using it, and where the code that defines it lives. Code is the source of truth; the README links to it instead of copying it.

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
- **Version:** 0.5.2 (or pinned commit)
- **License:** MIT
- **Adapted:** Current local differences, stated as present-tense facts
```

Omit this section for original (non-vendored) extensions. When local divergences need a re-apply checklist for upstream syncs, keep it in the extension's `AGENTS.md` under `## Local Tweaks`, stated as current differences, not as a change history.

### 3. Features / What It Does

Describe user-visible behavior and stable contracts in brief bullets or short paragraphs. Group by feature area when the extension does several things.

### 4. Entry Points

Name the commands or tools a reader needs to get started, then link to the file that registers them (for example `index.ts` or `src/commands.ts`). The registration code owns the complete set of tools, parameters, commands, hooks, and events.

### 5. Configuration (if any)

State where configuration lives (config file path, environment variable, settings command) and link to the code that defines keys and defaults.

## What to Omit

- **Code inventories** — exhaustive lists of tools, parameters, commands, hooks, events, config keys, defaults, model chains, limits, or source-file maps. Link to the owning code instead.
- **History** — dates, "previously", "no longer", "renamed from", migration notes, before/after stories, and change ledgers. Git and `CHANGELOG.md` own history.
- **Implementation details** that only matter to the code itself.
- **Duplicated AGENTS.md content** — the README is for users and consumers; `AGENTS.md` holds the contracts for agents editing the extension.

## Naming

- File is always `README.md` (uppercase)
- Placed at the extension root: `extensions/foo/README.md`
