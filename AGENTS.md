# Nix Environment Awareness

**Context:** This environment uses the Nix package manager. Prefer ephemeral or project-scoped execution over mutating the host.

## Command Selection

1. **Project environment first**
   - If the repo has `flake.nix`, prefer `nix develop` for project work.
   - If the project already defines its own package manager or dev environment, use that instead of inventing a parallel setup.

2. **Choose the narrowest Nix command**
   - Use `nix develop` for project environments and repo-scoped work.
   - Use `nix shell` for ad-hoc tools, arbitrary commands, and multiple packages.
   - Use `nix run` for a single package's default executable.

3. **Avoid global mutable installs**
   - `apt` / `yum` installs on NixOS
   - `brew install` as the default answer on nix-darwin or mixed Nix systems
   - `pip install --global` / `pip install --user`
   - `npm install -g`
   - `sudo make install`

4. **Do not mutate the host environment unless the user explicitly asks for a persistent setup change**
   - Prefer ephemeral commands and project-scoped workflows over system-wide changes.

## Detailed Ad-hoc Guidance

For detailed Python, Node.js, and ad-hoc command selection, use the `nix-ad-hoc-execution` skill.

# Web Search Citation Format

When performing web searches and presenting results, ALWAYS include Google-style numbered citation notes inline with your answer, and list all sources at the end.

## Format

```
Answer with citations[1] based on web search results[2].

Sources:
[1] Example Source (https://example.test/source-1)
[2] Another Source (https://example.test/source-2)
```

## Rules

1. Place citation numbers `[N]` inline immediately after the claim or fact they support
2. List all referenced sources at the end under a `Sources:` heading
3. Each source entry must include a descriptive name and the full URL
4. Number citations sequentially starting from `[1]`
5. Every claim derived from a web search result MUST have a citation

# Next.js Initialization Protocol

**Next.js Initialization**: When starting work on a Next.js project, automatically
call the `init` tool from the next-devtools-mcp server FIRST. This establishes
proper context and ensures all Next.js queries use official documentation.
