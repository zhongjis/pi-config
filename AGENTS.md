# Global Agent Rules

## Core Principles

- Be direct. No filler, no preamble, no restating the question.
- Do the simplest thing that works. No premature abstractions, no over-engineering.
- Prefer readability over cleverness. Write code a tired person can understand.
- If something is unclear, ask before guessing. Wrong assumptions waste more time than a question.

## Code Quality

- No `any` types in TypeScript unless absolutely necessary — and leave a comment explaining why.
- Check `node_modules` for external API type definitions instead of guessing signatures.
- Never remove or downgrade working code to fix type errors — upgrade the dependency instead.
- Always ask before removing functionality or code that appears intentional.
- Prefer standard library and built-in solutions over adding dependencies.
- Keep functions short. If it needs a scroll, it needs a split.
- Name things for what they do, not what they are. `fetchUserOrders()` not `getData()`.

## Changes & Commits

- Make minimal, focused changes. Don't refactor unrelated code in the same change.
- Never commit unless explicitly asked.
- Run linters/type-checks after code changes (not docs) before considering work done.
- If you create or modify a test, run it and iterate until it passes.

## File Operations

- Read before writing. Understand existing code before modifying it.
- Prefer `edit` over `write` for existing files — surgical changes, not full rewrites.
- Never overwrite files without understanding their current content.

## Shell & Commands

- Never run destructive commands (`rm -rf`, `drop table`, `force push`) without explicit confirmation.
- Prefer short, composable commands over long pipelines.
- Always check exit codes — don't assume success.

## Problem Solving

- Start by understanding the problem. Read error messages carefully and fully.
- When debugging, form a hypothesis before making changes. Don't shotgun-fix.
- If a fix doesn't work after 2 attempts, step back and reconsider the approach.
- Explain your reasoning when the solution isn't obvious.

## Communication

- When presenting options, give a clear recommendation with reasoning.
- If a task is ambiguous, propose a concrete plan and ask for confirmation.
- Don't explain things I didn't ask about. Stay on task.

# Nix Environment Awareness

**Context:** This system may use NixOS, nix-darwin (macOS), or have Nix installed as a standalone package manager. Traditional package installation methods may not work or may not persist correctly.

## When a Command is Not Found

**MANDATORY PROTOCOL:**

1. **Confirm the OS/Environment FIRST**

   ```bash
   uname -a
   cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null
   ```

2. **Check if Nix is Available**

   ```bash
   command -v nix && echo "Nix is installed"
   ```

3. **If Nix is Present: Use `nix shell` for Ad-hoc Commands**

   ```bash
   # WRONG: Try to install globally (may fail or not persist)
   apt install jq      # Won't work on NixOS
   brew install jq     # May conflict with Nix on macOS

   # CORRECT: Use nix shell for ad-hoc execution
   nix shell nixpkgs#jq -c "jq '.key' file.json"

   # Or for multiple packages
   nix shell nixpkgs#jq nixpkgs#yq -c "jq ... | yq ..."
   ```

## Nix Package Manager Considerations

### Systems Where Nix May Be Present

| System                 | Configuration                                            |
| ---------------------- | -------------------------------------------------------- |
| **NixOS**              | Full OS managed by Nix - no traditional package managers |
| **macOS + nix-darwin** | System packages managed by Nix, Homebrew may coexist     |
| **macOS + Nix**        | Nix installed standalone alongside Homebrew              |
| **Linux + Nix**        | Nix installed alongside system package manager           |

### What to Avoid on Nix-Managed Systems

| Action                     | Issue                                            |
| -------------------------- | ------------------------------------------------ |
| `apt/yum install` on NixOS | NixOS doesn't use traditional package managers   |
| `pip install --global`     | Global Python packages break Nix isolation       |
| `npm install -g`           | Global npm packages may not persist or integrate |
| `sudo make install`        | Won't integrate with Nix package management      |

### What You SHOULD Do

| Need                    | Solution                                      |
| ----------------------- | --------------------------------------------- |
| Run a command once      | `nix shell nixpkgs#package -c command args`   |
| Run in current shell    | `nix shell nixpkgs#package` then run commands |
| Multiple packages       | `nix shell nixpkgs#pkg1 nixpkgs#pkg2 -c ...`  |
| Development environment | Check for `flake.nix` and use `nix develop`   |

## Ad-hoc Python with Libraries

Python is the most common case where agents need packages beyond the base interpreter. The standard `pip install` approach conflicts with Nix isolation.

### Option 1: `uv` (Preferred when available)

`uv` handles ephemeral Python environments automatically:

```bash
# Check if uv is available
command -v uv && echo "uv is installed"

# Run script with ad-hoc dependencies
uv run --with pandas --with requests python3 script.py

# One-liner execution
uv run --with requests python3 -c "import requests; print(requests.get('https://example.com').status_code)"

# Multiple packages
uv run --with pandas --with matplotlib --with numpy python3 analyze.py
```

For self-contained scripts, use PEP 723 inline metadata:

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pandas", "requests"]
# ///
import pandas as pd
import requests
# ... script body
```

### Option 2: `nix shell` with `python3.withPackages`

Pure Nix approach — works anywhere Nix is installed:

```bash
# Python with specific packages
nix shell --impure --expr 'with import <nixpkgs> {}; python3.withPackages (ps: with ps; [pandas requests])' -c python3 script.py

# Interactive Python with packages
nix shell --impure --expr 'with import <nixpkgs> {}; python3.withPackages (ps: with ps; [numpy matplotlib])'
```

> **Note:** Nixpkgs Python package names may differ from PyPI names. Use `nix search nixpkgs python3Packages.<name>` to find the correct attribute.

### What to Avoid with Python

| Action                          | Issue                                           |
| ------------------------------- | ----------------------------------------------- |
| `pip install <package>`         | Breaks Nix isolation, may not persist           |
| `pip install --user <package>`  | Pollutes user site-packages, conflicts with Nix |
| `python -m venv && pip install` | Manual venvs bypass Nix dependency tracking     |
| `sudo pip install`              | System-wide install, breaks Nix-managed Python  |

### Decision Tree for Python

```
Need Python with libraries?
    │
    ├─► Is `uv` available? (`command -v uv`)
    │       │
    │       ├─► YES: uv run --with <pkg1> --with <pkg2> python3 script.py
    │       │
    │       └─► NO: Is `nix` available?
    │               │
    │               ├─► YES: nix shell --impure --expr 'with import <nixpkgs> {};
    │               │        python3.withPackages (ps: with ps; [pkg1 pkg2])' -c python3 script.py
    │               │
    │               └─► NO: python -m venv .venv && source .venv/bin/activate && pip install ...
    │
    └─► For project work: Check for flake.nix/pyproject.toml first → use `nix develop` or `uv sync`
```

## Ad-hoc Node.js / npm Packages

Running Node.js tools and scripts with npm dependencies without polluting the global environment.

### Option 1: `npx` (Preferred when Node.js is available)

`npx` runs packages without global install:

```bash
# Run a CLI tool once
npx cowsay "hello"
npx ts-node script.ts
npx tsx script.ts

# Run with a specific package version
npx create-react-app@latest my-app
npx prettier --write .
```

### Option 2: `nix shell` + `npx`

When Node.js itself is not installed:

```bash
# Get Node.js via Nix, then use npx
nix shell nixpkgs#nodejs -c npx cowsay "hello"
nix shell nixpkgs#nodejs -c npx ts-node script.ts

# Get Node.js + specific global tools
nix shell nixpkgs#nodejs nixpkgs#nodePackages.typescript -c tsc --version
nix shell nixpkgs#nodejs nixpkgs#nodePackages.prettier -c prettier --write .

# Interactive shell with Node.js
nix shell nixpkgs#nodejs
```

### Running Scripts with Dependencies

For scripts that need npm packages:

```bash
# If package.json exists in the project
nix shell nixpkgs#nodejs -c sh -c "npm install && node script.js"

# For a quick one-off with a dependency
nix shell nixpkgs#nodejs -c npx -p axios -p cheerio node -e "const axios = require('axios'); ..."
```

### What to Avoid with Node.js

| Action                        | Issue                                               |
| ----------------------------- | --------------------------------------------------- |
| `npm install -g <package>`    | Global installs may not persist, conflicts with Nix |
| `sudo npm install -g`         | System-wide install, breaks Nix-managed Node.js     |
| `corepack enable` without Nix | May conflict with Nix-managed package managers      |

### Decision Tree for Node.js

```
Need to run a Node.js tool or script?
    │
    ├─► Is `node`/`npx` available? (`command -v npx`)
    │       │
    │       ├─► YES: npx <tool> or npm install (local to project)
    │       │
    │       └─► NO: Is `nix` available?
    │               │
    │               ├─► YES: nix shell nixpkgs#nodejs -c npx <tool>
    │               │
    │               └─► NO: Install Node.js via system package manager
    │
    └─► For project work: Check for flake.nix first → use `nix develop`
```

## Quick Reference

### Ad-hoc Command Execution

```bash
# Pattern: nix shell nixpkgs#<package> -c <command> [args]

# Examples
nix shell nixpkgs#jq -c "jq '.name' package.json"
nix shell nixpkgs#ripgrep -c "rg 'pattern' ."
nix shell nixpkgs#fd -c "fd -e nix"
nix shell nixpkgs#httpie -c "http GET example.com"
nix shell nixpkgs#curl nixpkgs#jq -c "curl -s api.example.com | jq ."
```

### Finding Package Names

```bash
# Search for packages
nix search nixpkgs packagename

# Or use the nh wrapper if available
nh search packagename
```

### Check Environment Type

```bash
# NixOS
nixos-version 2>/dev/null && echo "NixOS"

# nix-darwin (macOS with Nix system management)
command -v darwin-rebuild && echo "nix-darwin"

# Standalone Nix
command -v nix && echo "Nix available"

# Check for Nix store
ls /nix/store &>/dev/null && echo "Nix store present"
```

## Decision Tree

```
Command not found?
    │
    ├─► Is `nix` command available?
    │       │
    │       ├─► YES: Use `nix shell nixpkgs#package -c command`
    │       │
    │       └─► NO: Use appropriate package manager for that OS
    │               (apt, brew, yum, etc.)
    │
    └─► When in doubt, check: command -v nix
```

## Important Notes

1. **Ephemeral by Design**: `nix shell` packages don't persist after the shell exits - this is intentional
2. **Reproducibility**: Nix ensures consistent package versions across runs
3. **No Side Effects**: Running `nix shell` won't modify system configuration
4. **Flakes Preferred**: If the project has `flake.nix`, prefer `nix develop` for development shells
5. **Check Project First**: Always check if the project provides dev shells before reaching for `nix shell`
6. **Mixed Systems**: On macOS with both Nix and Homebrew, prefer `nix shell` for consistency with this configuration

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

# Enterprise Codebase Strategy

**Context:** You are working on enterprise-level codebases with established patterns, multiple contributors, and production dependencies. Changes have downstream impacts on teams, deployments, and customers.

**Goal:** Minimize risk, maximize stability, and respect existing architectural decisions through conservative, deliberate changes.

## Core Principles

1. **Conservative by Default**: Every change is a potential regression. Prefer the smallest change that achieves the goal.
2. **Pattern Preservation**: Existing patterns exist for reasons you may not fully understand. Follow them unless explicitly authorized to deviate.
3. **Explicit Approval**: Never refactor, restructure, or "improve" code beyond the immediate task scope without user approval.

## 1. Change Philosophy

### The Minimal Change Rule

| Approach          | Risk Level | When to Use                                        |
| ----------------- | ---------- | -------------------------------------------------- |
| **Surgical**      | LOW        | Fix exactly what's broken, touch nothing else      |
| **Localized**     | MEDIUM     | Changes contained within a single module/component |
| **Cross-cutting** | HIGH       | Requires user approval + impact analysis           |
| **Architectural** | CRITICAL   | Never without explicit design review               |

**Default to SURGICAL.** Escalate scope only when necessary and with explicit approval.

### What "Conservative" Means in Practice

| Scenario                | Conservative (GOOD)              | Aggressive (BAD)                    |
| ----------------------- | -------------------------------- | ----------------------------------- |
| **Bug fix**             | Fix the bug only                 | Fix bug + refactor surrounding code |
| **Add feature**         | Follow existing patterns exactly | Introduce "better" pattern          |
| **Code smell found**    | Note it, do not fix              | Refactor while you're there         |
| **Inconsistent style**  | Match local style                | Normalize to your preference        |
| **Outdated dependency** | Leave it unless relevant         | Update it "while you're there"      |

## 2. Pattern Preservation Protocol

### MANDATORY: Before Writing Any Code

1. **Identify the local pattern**: Read 2-3 similar files/functions in the same module
2. **Match it exactly**: Same naming, same structure, same error handling
3. **When patterns conflict**: Ask which to follow, don't pick arbitrarily

### Format Matching (CRITICAL)

**Match the EXISTING format exactly, even if it's "wrong" or inconsistent with best practices.**

| Situation                               | Correct Action            | Wrong Action               |
| --------------------------------------- | ------------------------- | -------------------------- |
| File uses tabs, project uses spaces     | Use tabs (match file)     | Use spaces (match project) |
| Inconsistent indentation in function    | Match the inconsistency   | Fix the indentation        |
| Missing trailing commas in list         | Don't add trailing commas | Add trailing commas        |
| Single quotes when doubles are standard | Use single quotes         | Use double quotes          |
| Unusual line breaks                     | Match the unusual breaks  | Normalize line breaks      |
| Wrong brace style                       | Match the wrong style     | Use correct style          |

**WHY THIS MATTERS:**

- Formatting changes create noisy diffs
- Makes code review harder (real changes hidden in formatting noise)
- Version control blame becomes useless
- Merge conflicts multiply
- Team members can't find actual changes

**THE RULE:**

> If surrounding code uses 3-space indentation with tabs mixed in and trailing semicolons missing, your new code uses 3-space indentation with tabs mixed in and trailing semicolons missing.

**Only fix formatting when:**

1. You are EXPLICITLY asked to fix formatting
2. The file is being reformatted as a dedicated task (not alongside other changes)

### Formatter Usage (RESTRICTED)

**DO NOT run formatters on existing files.** Formatters rewrite entire files and destroy the ability to review actual changes.

| File Type                                 | Formatter Allowed?           | Rationale                                        |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------ |
| **New file** (you created it)             | YES (follow module patterns) | No existing style, but match module conventions  |
| **Existing file** (any modification)      | NO                           | Match existing format manually                   |
| **Existing file** (dedicated format task) | YES                          | Only when formatting IS the task                 |
| **CI/pre-commit enforces formatting**     | YES (comply)                 | Tooling is authoritative; isolate format changes |

**EXCEPTION: When CI/Tooling Enforces Formatting**

If the repository has pre-commit hooks or CI that enforces formatting:

1. **Comply with tooling** - Fighting CI is futile and creates friction
2. **Isolate format changes** - Keep formatting in a separate commit or clearly marked section
3. **Minimize scope** - Only format files you actually modified, not the entire codebase
4. **Disclose explicitly** - "CI formatting applied to modified files"

**BANNED ACTIONS on existing files:**

- Running `prettier`, `black`, `gofmt`, `rustfmt`, etc.
- Using editor "format on save"
- Using "format document" commands
- Auto-formatting via LSP

**INSTEAD:**

- Read surrounding code
- Match indentation character (tab vs space) and width manually
- Match brace/bracket style manually
- Match quote style manually
- Match line break patterns manually

**THE PRINCIPLE:**

> Formatters are for new files only. Existing files are hand-matched to their local style, character by character if necessary.

### Pattern Hierarchy (When Multiple Exist)

1. **Local pattern** (same file/folder) - highest priority
2. **Module pattern** (same feature area)
3. **Codebase pattern** (project-wide conventions)
4. **Industry best practice** - lowest priority, only if nothing else exists

**CRITICAL**: Industry best practices DO NOT override established codebase patterns without explicit approval.

### Anti-Patterns (BLOCKING)

| Violation                             | Why It's Dangerous                                |
| ------------------------------------- | ------------------------------------------------- |
| "I improved the error handling style" | Inconsistency creates maintenance burden          |
| "I used a more modern syntax"         | Version compatibility concerns, team familiarity  |
| "I refactored while fixing"           | Scope creep, harder to review, hidden regressions |
| "I normalized the naming convention"  | Breaks muscle memory, potential import issues     |
| "I added better logging"              | May conflict with existing observability patterns |

## 3. Change Authorization Matrix

| Change Type             | Self-Authorized         | Requires Approval     |
| ----------------------- | ----------------------- | --------------------- |
| Fix exact bug described | YES                     | -                     |
| Add feature to spec     | YES (if pattern exists) | If new pattern needed |
| Modify shared utilities | -                       | ALWAYS                |
| Change API contracts    | -                       | ALWAYS                |
| Update dependencies     | -                       | ALWAYS                |
| Refactor/restructure    | -                       | ALWAYS                |
| "Improve" existing code | -                       | ALWAYS                |
| Add new patterns        | -                       | ALWAYS                |

### How to Request Approval

When you need to deviate from existing patterns or make scope-expanding changes:

```
I need to [describe change] to complete this task.

**Current pattern**: [what exists]
**Proposed change**: [what you want to do]
**Why existing pattern doesn't work**: [specific reason]
**Impact**: [files/modules affected]
**Risk**: [what could break]

Should I proceed with this change, or is there a way to achieve the goal within existing patterns?
```

## 4. Code Review Mindset

### Assume Your Changes Will Be Reviewed

- Every line will be questioned
- Unrelated changes will be rejected
- Scope creep will be caught

### Self-Review Checklist (Before Completion)

- [ ] Does this touch ONLY what's necessary for the task?
- [ ] Does every change directly serve the stated goal?
- [ ] Am I following existing patterns, not introducing new ones?
- [ ] Would a reviewer ask "why is this change included?"
- [ ] Could I explain every modified line in the PR description?

## 5. Generated, Lock, and Vendor Files

### DO NOT Hand-Edit Generated Files

| File Type              | Examples                                       | Correct Action                                      |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------- |
| **Generated code**     | `*.pb.go`, `*.generated.ts`, API clients       | Modify the source (proto, OpenAPI spec), regenerate |
| **Lock files**         | `package-lock.json`, `yarn.lock`, `Cargo.lock` | Let package manager update; don't edit manually     |
| **Vendor directories** | `vendor/`, `node_modules/`                     | Never modify; update source dependency instead      |
| **Build artifacts**    | `dist/`, `build/`, `.next/`                    | Never commit or modify manually                     |

**THE RULE:**

> If a file has a generator, modify the generator input, not the output.

### Lock File Changes

- Lock file changes should ONLY appear when dependencies actually change
- Unexpected lock file churn = something is wrong, investigate
- Large lock file diffs require approval (may indicate unintended dependency updates)

## 6. API, Data, and Contract Safety

### High-Risk Change Categories (ALWAYS REQUIRE APPROVAL)

| Category                  | Examples                                       | Why Critical                        |
| ------------------------- | ---------------------------------------------- | ----------------------------------- |
| **Public APIs**           | REST endpoints, GraphQL schema, RPC interfaces | Breaking changes affect consumers   |
| **Database schemas**      | Migrations, table modifications, index changes | Data integrity, rollback complexity |
| **Message/event schemas** | Kafka topics, event payloads, queue formats    | Downstream system compatibility     |
| **Config formats**        | YAML/JSON schemas, env var contracts           | Deployment failures, runtime errors |
| **Auth/permissions**      | Role definitions, scope changes, ACLs          | Security implications               |

### Backward Compatibility Requirements

When touching any contract (API, schema, event):

1. **Assume consumers exist** - Even if you don't see them
2. **Additive changes preferred** - New fields/endpoints are safer than modifications
3. **Deprecation before removal** - Never remove without deprecation period
4. **Version if breaking** - If breaking change is necessary, version the API

### Migration Safety

- **Never** write destructive migrations without explicit approval
- **Always** ensure migrations are reversible when possible
- **Test** migrations against production-like data volumes
- **Document** rollback procedures

## 7. Security and Privacy Guardrails

### NEVER Do These Without Security Review

| Action                               | Risk                          | Required        |
| ------------------------------------ | ----------------------------- | --------------- |
| Log user data / PII                  | Privacy violation, compliance | Security review |
| Log secrets, tokens, keys            | Credential exposure           | BLOCKED         |
| Weaken authentication                | Unauthorized access           | Security review |
| Weaken input validation              | Injection attacks             | Security review |
| Add new crypto/hashing               | Weak algorithms               | Security review |
| Modify serialization/deserialization | RCE vulnerabilities           | Security review |
| Change permission checks             | Privilege escalation          | Security review |

### Secrets Handling

- **Never** hardcode secrets, tokens, or credentials
- **Never** log sensitive data (mask if necessary for debugging)
- **Never** commit `.env` files or credential files
- **Always** use existing secret management patterns

### Input Validation

- **Never** remove or weaken existing validation
- **Never** trust user input without validation
- **Match** existing validation patterns exactly

## 8. Verification Requirements

### MANDATORY: Run Available Checks

Before declaring any change complete:

| Check Type            | When Available      | Action                                             |
| --------------------- | ------------------- | -------------------------------------------------- |
| **Unit tests**        | Test files exist    | Run tests for modified code                        |
| **Lint/type check**   | Linter configured   | Run and fix errors (not warnings in existing code) |
| **Build**             | Build script exists | Ensure build passes                                |
| **Integration tests** | Test suite exists   | Run if changes touch integration points            |

### When Checks Cannot Be Run

If you cannot run verification:

1. **State explicitly** what you couldn't verify
2. **Explain why** (no test infra, credentials needed, etc.)
3. **Suggest** what would validate the change
4. **Do not claim** the change is verified

**THE RULE:**

> Unverified changes are explicitly labeled as unverified. Never imply confidence you don't have.

## 9. Dependency and Environment Caution

### Dependencies

| Action                     | Risk   | Guidance                                                   |
| -------------------------- | ------ | ---------------------------------------------------------- |
| Add new dependency         | HIGH   | Always ask first; may have security/licensing implications |
| Update existing dependency | MEDIUM | Only if directly relevant to task                          |
| Remove dependency          | HIGH   | Always ask first; may have hidden usages                   |
| Change version constraint  | MEDIUM | Ask first; affects entire team                             |

### Environment and Configuration

- **Never** modify build configurations (CI/CD pipelines, build scripts, Makefiles, bundler configs, task runners, etc.) unless absolutely unavoidable to complete the task. If unavoidable, **MUST get explicit user approval** before making the change — explain why it's necessary and what the impact will be.
- **Never** alter environment variables or secrets references
- **Never** modify infrastructure-as-code files casually

## 10. Communication Standards

### Proactive Disclosure

Always inform the user when you encounter:

1. **Conflicting patterns** - "I found two different approaches for X. Which should I follow?"
2. **Missing context** - "I'm unsure how this integrates with Y. Can you clarify?"
3. **Potential scope expansion** - "To do this properly, I'd also need to modify Z. Should I proceed?"
4. **Technical debt** - "I noticed [issue] but left it untouched per conservative approach."

### Documentation of Decisions

For any non-trivial change, be prepared to explain:

- **What** was changed
- **Why** it was necessary
- **Why this approach** over alternatives
- **What was NOT changed** (and why)

## 11. Error Handling and Edge Cases

### When Something Breaks

1. **Return to known-good state** - Undo changes to restore working behavior (not necessarily `git revert` - use judgment)
2. **Understand the failure** - Don't guess at fixes
3. **Fix minimally** - Address root cause only
4. **Verify thoroughly** - Test the exact scenario that broke

### When You're Uncertain

| Uncertainty                 | Action                        |
| --------------------------- | ----------------------------- |
| Not sure of the pattern     | Read more code before writing |
| Not sure of the impact      | Ask before changing           |
| Not sure of the requirement | Clarify before implementing   |
| Not sure it's within scope  | Ask before expanding          |

**DEFAULT BEHAVIOR**: When uncertain, ask. Never assume.

## 12. Summary: The Enterprise Developer Mindset

> "I am a guest in this codebase. I follow the house rules, I clean up only what I'm asked to, and I leave everything else exactly as I found it."

**Remember**:

- Stability > Elegance
- Consistency > Best Practice
- Explicit Approval > Implicit Assumption
- Minimal Change > Comprehensive Improvement
