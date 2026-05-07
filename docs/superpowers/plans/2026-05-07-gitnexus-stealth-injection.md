# GitNexus Stealth Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/gitnexus analyze` leave zero working-tree changes. Skills and GitNexus contract reach the agent via pi-native runtime injection instead of CLI-written files.

**Architecture:** Three-part pi-native injection: (1) expand the existing `before_agent_start` handler to append GitNexus contract prose + runtime-derived skill list from `event.systemPromptOptions.skills`; (2) pass `--skip-agents-md --no-stats` to the `gitnexus analyze` spawn so the binary stops writing `AGENTS.md`/`CLAUDE.md`; (3) add `.gitignore` entries + one-time deletion of the committed block in root `AGENTS.md`. Plus follow-up: `VERSION` file + drift detect at `session_start`, a manual sync script using a scratch directory, an automated integration test, and README update.

**Tech Stack:** TypeScript (extensions), pi-coding-agent 0.70.6 ExtensionAPI, Vitest (root config includes `extensions/**/*.test.ts`), bash (sync script), Nix-pinned `gitnexus` binary (v1.6.3).

**Source spec:** `docs/superpowers/specs/2026-05-07-gitnexus-stealth-injection-design.md` (commit 4220d9a after round-2 edits).

**Round-2 reviewer notes to honor:**
1. `BuildSystemPromptOptions.skills` is **optional** — use `?? []` coalescing.
2. Test assertions on skill-name matching use **word-boundary regex**, not `.includes()`.
3. Notify severity is `"warning"` (existing convention), not `"warn"`.
4. `event.systemPrompt` is typed `string` in pi core, but existing gitnexus handler uses a loose local type `{ systemPrompt?: string }` — keep that loose type for minimum-diff, gate on `event.systemPrompt == null` as today.

---

## File Structure

**Modified:**
- `extensions/gitnexus/src/index.ts` — expand `before_agent_start`, extract prose constant, add runtime skill derivation, pass `--skip-agents-md --no-stats` to analyze spawn, add drift check in `session_start`.
- `AGENTS.md` — delete lines 109–151 (the `<!-- gitnexus:start -->` through `<!-- gitnexus:end -->` block) plus the preceding blank line if present.
- `.gitignore` — append `.claude/` and `CLAUDE.md`.
- `extensions/gitnexus/README.md` — add Local Additions entries.

**Created:**
- `extensions/gitnexus/test/stealth-injection.test.ts` — first tests in this package. Unit + mocked integration.
- `extensions/gitnexus/test/analyze-clean-tree.integration.test.ts` — automated integration test #8 (spawn real `gitnexus` in scratch tmp dir, assert `git status --porcelain` empty).
- `extensions/gitnexus/skills/VERSION` — single line, binary version string (e.g., `1.6.3\n`).
- `scripts/sync-gitnexus-resources.sh` — manual upstream sync script, bash.

**Boundary rationale:** Extension code (`src/index.ts`) owns injection logic, flag composition, and drift detection. Sync script lives outside the extension because it runs the binary in a scratch dir, not through the extension. `.gitignore` + the one-time `AGENTS.md` cleanup are repo-root concerns, kept separate from extension code. Tests are colocated with the extension per root AGENTS.md convention.

---

## Testing Prerequisites

Before Task 1: confirm test harness state.

- [ ] **Step 0.1: Confirm `extensions/gitnexus/` has no existing tests**

Run: `fd '\.test\.ts$' extensions/gitnexus`
Expected: empty output.

- [ ] **Step 0.2: Confirm `vitest.config.ts` picks up `extensions/gitnexus/test/*.test.ts`**

Run: `grep -n 'extensions/\*\*' vitest.config.ts`
Expected: output includes `extensions/**/*.test.ts` glob at around line 25.

- [ ] **Step 0.3: Confirm installed pi API surface**

Run: `grep -n 'systemPromptOptions\|BuildSystemPromptOptions' node_modules/.pnpm/@mariozechner+pi-coding-agent@*/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`
Expected: hit for `systemPromptOptions: BuildSystemPromptOptions`. If not, stop and escalate — API assumption failed.

Run: `grep -n 'skills' node_modules/.pnpm/@mariozechner+pi-coding-agent@*/node_modules/@mariozechner/pi-coding-agent/dist/core/system-prompt.d.ts`
Expected: hit for `skills?: Skill[]` (optional).

---

## Atomic Group — Tasks 1–3 must land as a single commit or strictly sequential PRs

Landing step 3 before steps 1–2 = `/gitnexus analyze` re-writes the block that step 3 just deleted → dirty tree. Either commit all three together, or merge in strict order with no other changes in between.

---

### Task 1: Expand `before_agent_start` handler with prose + runtime-derived skill list

**Files:**
- Modify: `extensions/gitnexus/src/index.ts` (lines 76–88 currently hold the one-liner injection)
- Create: `extensions/gitnexus/test/stealth-injection.test.ts`

- [ ] **Step 1.1: Write the failing tests first (TDD)**

Create `extensions/gitnexus/test/stealth-injection.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

// Mock fs before importing the extension so findGitNexusIndex is mockable.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, existsSync: vi.fn() };
});

type SkillInfo = { name: string };
interface BeforeAgentStartEvent {
  systemPrompt?: string;
  systemPromptOptions?: { skills?: SkillInfo[] };
}

// The handler we'll extract from index.ts in Step 1.3.
// Import path will be `../src/stealth-injection.js` after the extraction.
// Until the module exists, these tests fail with a module-not-found error,
// which is the expected failing state for Step 1.2.
import { buildInjectedSystemPrompt } from '../src/stealth-injection.js';

describe('buildInjectedSystemPrompt', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReset();
  });

  it('returns undefined when no .gitnexus/ index present (no injection)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: [{ name: 'gitnexus-exploring' }],
    });
    expect(result).toBeUndefined();
  });

  it('injects prose containing signature tokens when index is present', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: [{ name: 'gitnexus-exploring' }],
    });
    expect(result).toBeDefined();
    expect(result).toMatch(/\bgitnexus_query\b/);
    expect(result).toMatch(/\bgitnexus_impact\b/);
    expect(result!.startsWith('BASE')).toBe(true);
  });

  it('lists loaded gitnexus skills by name with word-boundary match', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: [
        { name: 'gitnexus-exploring' },
        { name: 'gitnexus-impact-analysis' },
        { name: 'gitnexus-pr-review' },
        { name: 'some-other-skill' },
      ],
    });
    expect(result).toMatch(/\bgitnexus-exploring\b/);
    expect(result).toMatch(/\bgitnexus-impact-analysis\b/);
    expect(result).toMatch(/\bgitnexus-pr-review\b/);
    expect(result).not.toMatch(/\bsome-other-skill\b/);
  });

  it('never includes .claude/skills/ paths in injected text', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: [{ name: 'gitnexus-exploring' }],
    });
    expect(result).not.toContain('.claude/skills');
  });

  it('emits fallback pointing at sync script when zero gitnexus skills loaded', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: [{ name: 'some-other-skill' }],
    });
    expect(result).toMatch(/sync-gitnexus-resources\.sh/);
    expect(result).not.toMatch(/\bgitnexus-exploring\b/);
  });

  it('handles undefined skills array with ?? [] coalescing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: undefined,
    });
    expect(result).toMatch(/sync-gitnexus-resources\.sh/);
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `pnpm vitest run extensions/gitnexus/test/stealth-injection.test.ts`
Expected: FAIL — module `../src/stealth-injection.js` does not exist.

- [ ] **Step 1.3: Extract the prose constant and handler logic into a new module**

Create `extensions/gitnexus/src/stealth-injection.ts`:

```typescript
import { findGitNexusIndex } from './gitnexus.js';

export interface BuildInjectedSystemPromptArgs {
  base: string;
  cwd: string;
  skills?: Array<{ name: string }>;
}

// Prose-only. No filesystem paths, no skill names. Skill list is derived at runtime.
export const GITNEXUS_CONTRACT_PROSE = `# GitNexus — Code Intelligence

GitNexus indexes this codebase as a knowledge graph. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run \`/gitnexus analyze\` to rebuild it.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run \`gitnexus_impact({target: "symbolName", direction: "upstream"})\` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run \`gitnexus_detect_changes()\` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use \`gitnexus_query({query: "concept"})\` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use \`gitnexus_context({name: "symbolName"})\`.

## Never Do

- NEVER edit a function, class, or method without first running \`gitnexus_impact\` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use \`gitnexus_rename\` which understands the call graph.
- NEVER commit changes without running \`gitnexus_detect_changes()\` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| \`gitnexus://repos\` | List all indexed repositories |
| \`gitnexus://repo/{name}/context\` | Codebase overview, check index freshness |
| \`gitnexus://repo/{name}/clusters\` | All functional areas |
| \`gitnexus://repo/{name}/processes\` | All execution flows |
| \`gitnexus://repo/{name}/process/{name}\` | Step-by-step execution trace |`;

/**
 * Build the systemPrompt to inject. Returns undefined when no index is present
 * (no injection). Otherwise returns base + prose + runtime-derived skill section.
 */
export function buildInjectedSystemPrompt(args: BuildInjectedSystemPromptArgs): string | undefined {
  if (!findGitNexusIndex(args.cwd)) return undefined;

  const gitnexusSkills = (args.skills ?? []).filter(s => s.name.startsWith('gitnexus-'));

  let skillSection: string;
  if (gitnexusSkills.length === 0) {
    skillSection = '\n\n## Loaded Skills\n\nNo gitnexus-* skills currently loaded. If you expect them, run `scripts/sync-gitnexus-resources.sh` to refresh vendored skills against the installed binary.';
  } else {
    const names = gitnexusSkills.map(s => `- \`${s.name}\``).join('\n');
    skillSection = `\n\n## Loaded Skills\n\nThe following gitnexus skills are loaded and available by name:\n\n${names}`;
  }

  return args.base + '\n\n' + GITNEXUS_CONTRACT_PROSE + skillSection;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `pnpm vitest run extensions/gitnexus/test/stealth-injection.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 1.5: Wire the new module into `before_agent_start`**

In `extensions/gitnexus/src/index.ts`, replace the existing handler body (lines 76–88, the one that appends `'\n\n[GitNexus active]...'`). New import at the top of file:

```typescript
import { buildInjectedSystemPrompt } from './stealth-injection.js';
```

Replace the handler:

```typescript
  // Inject GitNexus contract + runtime-derived skill list into system prompt.
  pi.on('before_agent_start', async (event: { systemPrompt?: string; systemPromptOptions?: { skills?: Array<{ name: string }> } }, ctx: ExtensionContext) => {
    if (event.systemPrompt == null) return;
    const injected = buildInjectedSystemPrompt({
      base: event.systemPrompt,
      cwd: ctx.cwd,
      skills: event.systemPromptOptions?.skills,
    });
    if (injected === undefined) return;
    return { systemPrompt: injected };
  });
```

- [ ] **Step 1.6: Typecheck and re-run tests**

Run: `pnpm lint:typecheck`
Expected: PASS (or same baseline errors as before, if any).

Run: `pnpm vitest run extensions/gitnexus/test/stealth-injection.test.ts`
Expected: PASS.

- [ ] **Step 1.7: Do NOT commit yet — Tasks 1–3 land together (atomic group).** Proceed to Task 2.

---

### Task 2: Pass `--skip-agents-md --no-stats` to `/gitnexus analyze` spawn

**Files:**
- Modify: `extensions/gitnexus/src/index.ts:323` (the `spawn(bin, [...baseArgs, 'analyze'], ...)` call inside the `/gitnexus analyze` handler)
- Modify: `extensions/gitnexus/test/stealth-injection.test.ts` — add args-composition test

- [ ] **Step 2.1: Write the failing test (args shape check)**

The analyze handler is deep inside a slash command closure; test by extracting a pure helper. Add to `extensions/gitnexus/src/stealth-injection.ts`:

```typescript
/**
 * Compose the argv passed to `spawn(bin, composeAnalyzeArgs(baseArgs, userRest))`.
 * Always prepends --skip-agents-md --no-stats. Never passes --skills.
 */
export function composeAnalyzeArgs(baseArgs: string[], userRest: string[] = []): string[] {
  return [...baseArgs, 'analyze', '--skip-agents-md', '--no-stats', ...userRest];
}
```

Append to the existing `extensions/gitnexus/test/stealth-injection.test.ts`:

```typescript
import { composeAnalyzeArgs } from '../src/stealth-injection.js';

describe('composeAnalyzeArgs', () => {
  it('always prepends --skip-agents-md and --no-stats after the analyze subcommand', () => {
    const args = composeAnalyzeArgs([]);
    expect(args).toEqual(['analyze', '--skip-agents-md', '--no-stats']);
  });

  it('preserves base args (e.g., for npx wrapper)', () => {
    const args = composeAnalyzeArgs(['--some-base-flag']);
    expect(args).toEqual(['--some-base-flag', 'analyze', '--skip-agents-md', '--no-stats']);
  });

  it('appends user args after the stealth flags', () => {
    const args = composeAnalyzeArgs([], ['--force']);
    expect(args).toEqual(['analyze', '--skip-agents-md', '--no-stats', '--force']);
  });

  it('never includes --skills', () => {
    const args = composeAnalyzeArgs([], ['--force']);
    expect(args).not.toContain('--skills');
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `pnpm vitest run extensions/gitnexus/test/stealth-injection.test.ts`
Expected: FAIL — `composeAnalyzeArgs` export doesn't exist yet.

- [ ] **Step 2.3: Add the helper**

Append the `composeAnalyzeArgs` function from Step 2.1 to `extensions/gitnexus/src/stealth-injection.ts`.

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `pnpm vitest run extensions/gitnexus/test/stealth-injection.test.ts`
Expected: PASS — 10 tests total (6 from Task 1 + 4 new).

- [ ] **Step 2.5: Wire the helper into the `/gitnexus analyze` spawn**

In `extensions/gitnexus/src/index.ts`, at the top of the file (with other imports from `./stealth-injection.js`):

```typescript
import { buildInjectedSystemPrompt, composeAnalyzeArgs } from './stealth-injection.js';
```

At line 323 (the `const proc = spawn(bin, [...baseArgs, 'analyze'], {` line), replace with:

```typescript
          const proc = spawn(bin, composeAnalyzeArgs(baseArgs), {
```

- [ ] **Step 2.6: Typecheck**

Run: `pnpm lint:typecheck`
Expected: PASS.

- [ ] **Step 2.7: Do NOT commit yet — proceed to Task 3.**

---

### Task 3: Delete AGENTS.md block + add `.gitignore` entries

**Files:**
- Modify: `AGENTS.md` — delete lines 109–151 (block from `<!-- gitnexus:start -->` through `<!-- gitnexus:end -->`) plus any preceding blank line.
- Modify: `.gitignore` — append `.claude/` and `CLAUDE.md`.

- [ ] **Step 3.1: Verify block boundaries before editing**

Run: `grep -n 'gitnexus:start\|gitnexus:end' AGENTS.md`
Expected: two lines, `109:<!-- gitnexus:start -->` and `151:<!-- gitnexus:end -->`. If different numbers, use those in the next step instead of hard-coded 109/151.

Run: `sed -n '107,109p' AGENTS.md`
Expected: line 107 has content, line 108 is blank, line 109 has the start marker. Confirms there's a blank line separator to remove.

- [ ] **Step 3.2: Delete the block and the preceding blank line**

Use a single sed invocation (portable, works on macOS and Linux with `-i ''` / `-i` differences — use a tempfile to avoid that):

```bash
awk 'NR<108 || NR>151' AGENTS.md > AGENTS.md.tmp && mv AGENTS.md.tmp AGENTS.md
```

(108 = blank-line separator; 151 = end marker. Adjust if Step 3.1 showed different numbers.)

- [ ] **Step 3.3: Verify block is gone and file ends clean**

Run: `grep -c 'gitnexus:start\|gitnexus:end' AGENTS.md`
Expected: `0`.

Run: `tail -5 AGENTS.md`
Expected: last lines do not contain a trailing blank-line gap where the block used to be. If trailing blank lines exist, trim them.

- [ ] **Step 3.4: Append `.gitignore` entries**

```bash
printf '\n# GitNexus stealth — artifacts if someone runs the binary bare outside pi\n.claude/\nCLAUDE.md\n' >> .gitignore
```

- [ ] **Step 3.5: Verify `.gitignore`**

Run: `tail -5 .gitignore`
Expected: `.claude/` and `CLAUDE.md` present at bottom.

Run: `git check-ignore -v .claude CLAUDE.md`
Expected: both match the new rule lines.

- [ ] **Step 3.6: Remove current untracked artifacts from disk (one-time cleanup)**

Run: `git status --short | grep -E '(\.claude/|CLAUDE\.md)'`
Expected: lists `?? .claude/skills/gitnexus/...` and `?? CLAUDE.md`.

Run: `rm -rf .claude CLAUDE.md`

Run: `git status --short`
Expected: no more `??` lines for `.claude/` or `CLAUDE.md`.

- [ ] **Step 3.7: Run full typecheck + tests**

Run: `pnpm lint:typecheck`
Expected: PASS.

Run: `pnpm test:extensions`
Expected: PASS. New test file discovered; 10 assertions green.

- [ ] **Step 3.8: Commit Tasks 1, 2, 3 together (atomic group)**

```bash
git add extensions/gitnexus/src/stealth-injection.ts \
        extensions/gitnexus/src/index.ts \
        extensions/gitnexus/test/stealth-injection.test.ts \
        AGENTS.md \
        .gitignore

git commit -m "feat(gitnexus): stealth contract injection via before_agent_start

- Extract GITNEXUS_CONTRACT_PROSE + buildInjectedSystemPrompt helper
  into src/stealth-injection.ts. Handler derives gitnexus-* skill list
  from event.systemPromptOptions.skills at runtime; no static paths.
- Pass --skip-agents-md --no-stats to /gitnexus analyze spawn via
  composeAnalyzeArgs helper. Never pass --skills.
- Remove committed <!-- gitnexus:start/end --> block from root AGENTS.md.
- Ignore .claude/ and CLAUDE.md as defense in depth.

Per docs/superpowers/specs/2026-05-07-gitnexus-stealth-injection-design.md"
```

- [ ] **Step 3.9: Verify `git status` clean after a fresh `/gitnexus analyze`**

Manual check: open pi, run `/gitnexus analyze`, then:

Run: `git status --short`
Expected: empty output. This is the spec's top-level goal.

---

## Follow-up Tasks — Land in separate commits

---

### Task 4: Drift detection via `VERSION` file

**Files:**
- Create: `extensions/gitnexus/skills/VERSION` — single line, binary version.
- Modify: `extensions/gitnexus/src/index.ts` — extend existing `session_start` handler.
- Modify: `extensions/gitnexus/test/stealth-injection.test.ts` — drift tests.

- [ ] **Step 4.1: Write failing tests**

Append to `extensions/gitnexus/test/stealth-injection.test.ts`:

```typescript
import { checkSkillDrift } from '../src/stealth-injection.js';

describe('checkSkillDrift', () => {
  it('returns null (no drift message) when versions match', () => {
    const result = checkSkillDrift({ vendoredVersion: '1.6.3', binaryVersion: '1.6.3' });
    expect(result).toBeNull();
  });

  it('returns a warn-severity message when versions differ', () => {
    const result = checkSkillDrift({ vendoredVersion: '1.6.2', binaryVersion: '1.6.3' });
    expect(result).not.toBeNull();
    expect(result!.message).toMatch(/\b1\.6\.2\b/);
    expect(result!.message).toMatch(/\b1\.6\.3\b/);
    expect(result!.message).toMatch(/sync-gitnexus-resources\.sh/);
    expect(result!.severity).toBe('warning');
  });

  it('returns null when vendoredVersion is missing (undefined)', () => {
    const result = checkSkillDrift({ vendoredVersion: undefined, binaryVersion: '1.6.3' });
    expect(result).toBeNull();
  });

  it('returns null when binaryVersion is missing (undefined)', () => {
    const result = checkSkillDrift({ vendoredVersion: '1.6.3', binaryVersion: undefined });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `pnpm vitest run extensions/gitnexus/test/stealth-injection.test.ts`
Expected: FAIL — `checkSkillDrift` export doesn't exist.

- [ ] **Step 4.3: Add the helper**

Append to `extensions/gitnexus/src/stealth-injection.ts`:

```typescript
export interface DriftCheckArgs {
  vendoredVersion: string | undefined;
  binaryVersion: string | undefined;
}
export interface DriftNotice {
  message: string;
  severity: 'warning';
}

export function checkSkillDrift(args: DriftCheckArgs): DriftNotice | null {
  if (!args.vendoredVersion || !args.binaryVersion) return null;
  if (args.vendoredVersion === args.binaryVersion) return null;
  return {
    severity: 'warning',
    message: `[GitNexus] Vendored skills version ${args.vendoredVersion} differs from installed binary ${args.binaryVersion}. Run scripts/sync-gitnexus-resources.sh to refresh.`,
  };
}
```

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `pnpm vitest run extensions/gitnexus/test/stealth-injection.test.ts`
Expected: PASS — 14 tests total.

- [ ] **Step 4.5: Create `VERSION` file**

Run: `gitnexus --version | head -1`
Expected output: a version like `1.6.3`.

Write that version to `extensions/gitnexus/skills/VERSION`:

```bash
gitnexus --version | head -1 > extensions/gitnexus/skills/VERSION
```

Verify: `cat extensions/gitnexus/skills/VERSION` → single-line version, no trailing whitespace beyond newline.

- [ ] **Step 4.6: Wire drift check into `session_start`**

Locate the existing `session_start` handler in `extensions/gitnexus/src/index.ts` (search `pi.on('session_start'` or the `onSession` function). Inside it, after the binary probe completes, add:

```typescript
    // Drift check: compare vendored skills VERSION against installed binary.
    try {
      const versionFilePath = new URL('../skills/VERSION', import.meta.url).pathname;
      const vendoredVersion = (await import('node:fs')).readFileSync(versionFilePath, 'utf-8').trim() || undefined;
      const binaryVersionOut = await new Promise<string>((resolve_) => {
        let out = '';
        const [bin, ...args] = gitnexusCmd;
        const proc = spawn(bin, [...args, '--version'], { stdio: ['ignore', 'pipe', 'ignore'], env: spawnEnv });
        proc.stdout!.on('data', (d: { toString(): string }) => { out += d.toString(); });
        proc.on('close', () => resolve_(out.trim()));
        proc.on('error', () => resolve_(''));
      });
      const binaryVersion = binaryVersionOut.split('\n')[0]?.trim() || undefined;
      const drift = checkSkillDrift({ vendoredVersion, binaryVersion });
      if (drift) ctx.ui.notify(drift.message, drift.severity);
    } catch {
      // VERSION file missing or unreadable → skip silently per spec.
    }
```

Add import at the top:

```typescript
import { checkSkillDrift } from './stealth-injection.js';
// (or extend existing import of stealth-injection)
```

- [ ] **Step 4.7: Typecheck + test**

Run: `pnpm lint:typecheck && pnpm vitest run extensions/gitnexus/test/stealth-injection.test.ts`
Expected: PASS.

- [ ] **Step 4.8: Commit**

```bash
git add extensions/gitnexus/src/stealth-injection.ts \
        extensions/gitnexus/src/index.ts \
        extensions/gitnexus/test/stealth-injection.test.ts \
        extensions/gitnexus/skills/VERSION

git commit -m "feat(gitnexus): detect skill/binary version drift on session_start

Read extensions/gitnexus/skills/VERSION, compare against \`gitnexus --version\`,
notify(warning) with both versions and sync-script pointer on mismatch.
Non-blocking; missing VERSION file or binary skips silently."
```

---

### Task 5: Sync script

**Files:**
- Create: `scripts/sync-gitnexus-resources.sh`

- [ ] **Step 5.1: Write the script**

```bash
#!/usr/bin/env bash
# scripts/sync-gitnexus-resources.sh
# Manual sync of vendored GitNexus skills against installed binary templates.
# Runs gitnexus analyze in a scratch directory; diffs output against the vendored tree;
# prompts before applying. Never runs in the repo working tree.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
VENDORED_SKILLS="$REPO_ROOT/extensions/gitnexus/skills"
VERSION_FILE="$VENDORED_SKILLS/VERSION"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/sync-gitnexus-resources.sh [--dry-run]

Sync vendored GitNexus skill templates against the installed gitnexus binary.
Runs analyze in a scratch tmpdir; prompts before applying diffs into
extensions/gitnexus/skills/. Never touches the repo working tree without confirmation.

Options:
  --dry-run   Show diffs without applying or prompting.
  -h, --help  Show this help.

Exit codes:
  0  success or no-op
  1  upstream analyze failed
  2  user declined apply
  3  other error
EOF
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 3 ;;
  esac
done

command -v gitnexus >/dev/null || { echo "gitnexus not on PATH" >&2; exit 3; }
BINARY_VERSION="$(gitnexus --version | head -1 | tr -d '[:space:]')"
echo "Installed binary: gitnexus $BINARY_VERSION"

SCRATCH="$(mktemp -d -t gitnexus-sync.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

echo "Scratch dir: $SCRATCH"
cd "$SCRATCH"
git init --quiet
printf '{"name":"gitnexus-sync-scratch","version":"0.0.0"}\n' > package.json
mkdir -p src
printf '// placeholder\nexport const x = 1;\n' > src/index.ts
git add -A && git commit --quiet -m init

echo "Running gitnexus analyze --force --skills ..."
if ! gitnexus analyze --force --skills >/dev/null 2>&1; then
  echo "gitnexus analyze failed in scratch dir" >&2
  exit 1
fi

# Binary writes to .claude/skills/gitnexus/ inside the scratch dir.
SCRATCH_SKILLS="$SCRATCH/.claude/skills/gitnexus"
if [[ ! -d "$SCRATCH_SKILLS" ]]; then
  echo "gitnexus analyze ran but produced no .claude/skills/gitnexus/ output" >&2
  exit 1
fi

echo
echo "=== Skill diff summary ==="
CHANGED=0
ADDED=0
REMOVED=0

# Compare each scratch skill vs vendored.
for scratch_skill_dir in "$SCRATCH_SKILLS"/*/; do
  skill_name="$(basename "$scratch_skill_dir")"
  vendored_path="$VENDORED_SKILLS/$skill_name/SKILL.md"
  scratch_path="$scratch_skill_dir/SKILL.md"
  if [[ ! -f "$vendored_path" ]]; then
    echo "+ ADDED  $skill_name"
    ADDED=$((ADDED+1))
  elif ! diff -q "$scratch_path" "$vendored_path" >/dev/null 2>&1; then
    echo "~ MODIFIED $skill_name"
    CHANGED=$((CHANGED+1))
  fi
done

# Detect removed (vendored but not in scratch).
for vendored_skill_dir in "$VENDORED_SKILLS"/*/; do
  skill_name="$(basename "$vendored_skill_dir")"
  [[ "$skill_name" == "VERSION" ]] && continue
  if [[ ! -d "$SCRATCH_SKILLS/$skill_name" ]]; then
    echo "- REMOVED  $skill_name (vendored; not in binary templates)"
    REMOVED=$((REMOVED+1))
  fi
done

# VERSION file drift
CURRENT_VENDORED_VERSION=""
[[ -f "$VERSION_FILE" ]] && CURRENT_VENDORED_VERSION="$(cat "$VERSION_FILE" | tr -d '[:space:]')"
echo
echo "Vendored VERSION: ${CURRENT_VENDORED_VERSION:-<missing>}"
echo "Binary  VERSION: $BINARY_VERSION"

if [[ $CHANGED -eq 0 && $ADDED -eq 0 && $REMOVED -eq 0 && "$CURRENT_VENDORED_VERSION" == "$BINARY_VERSION" ]]; then
  echo "No drift. Nothing to sync."
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "Dry run. Exiting without changes."
  exit 0
fi

echo
read -r -p "Apply changes to $VENDORED_SKILLS? [y/N] " ANSWER
case "$ANSWER" in
  y|Y|yes|YES) ;;
  *) echo "Declined. Exiting."; exit 2 ;;
esac

# Apply: rsync each scratch skill into vendored tree; do NOT touch any other file.
for scratch_skill_dir in "$SCRATCH_SKILLS"/*/; do
  skill_name="$(basename "$scratch_skill_dir")"
  target_dir="$VENDORED_SKILLS/$skill_name"
  mkdir -p "$target_dir"
  rsync -a --delete "$scratch_skill_dir" "$target_dir/"
done

printf '%s\n' "$BINARY_VERSION" > "$VERSION_FILE"

echo
echo "Sync complete. Review with: git status -- extensions/gitnexus/skills/"
echo "Suggested commit: git commit -m \"chore(gitnexus): sync skills to binary v$BINARY_VERSION\""
```

- [ ] **Step 5.2: Make it executable**

```bash
chmod +x scripts/sync-gitnexus-resources.sh
```

- [ ] **Step 5.3: Smoke-test with `--dry-run`**

Run: `scripts/sync-gitnexus-resources.sh --dry-run`
Expected: prints binary version, scratch dir path, skill diff summary (likely several MODIFIED entries since vendored is from commit db34bcc while binary is 1.6.3), version comparison, `Dry run. Exiting without changes.`, exit code 0.

Run: `git status --short`
Expected: no new changes from the dry-run itself.

- [ ] **Step 5.4: Commit the script**

```bash
git add scripts/sync-gitnexus-resources.sh
git commit -m "feat(scripts): add sync-gitnexus-resources.sh for manual upstream sync

Runs gitnexus analyze --force --skills in a scratch tmpdir, diffs output
against extensions/gitnexus/skills/, prompts before applying. Manual
invocation only; never auto-runs. Dry-run flag supported."
```

---

### Task 6: Automated integration test — `/gitnexus analyze` leaves tree clean

**Files:**
- Create: `extensions/gitnexus/test/analyze-clean-tree.integration.test.ts`

- [ ] **Step 6.1: Write the integration test**

```typescript
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeAnalyzeArgs } from '../src/stealth-injection.js';

const hasBinary = spawnSync('gitnexus', ['--version'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasBinary)('gitnexus analyze leaves git tree clean', () => {
  it('with --skip-agents-md --no-stats, scratch repo has no working-tree changes after analyze', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gitnexus-clean-tree-'));

    // Minimal indexable scratch repo
    spawnSync('git', ['init', '--quiet'], { cwd: scratch });
    writeFileSync(join(scratch, 'package.json'), '{"name":"t","version":"0.0.0"}\n');
    writeFileSync(join(scratch, 'index.ts'), 'export const x = 1;\n');
    spawnSync('git', ['add', '-A'], { cwd: scratch });
    spawnSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: scratch });

    // Run analyze with our composed args.
    const args = composeAnalyzeArgs([]);
    const result = spawnSync('gitnexus', args, { cwd: scratch, stdio: 'ignore' });
    expect(result.status).toBe(0);

    // Assert: working tree clean.
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: scratch, encoding: 'utf-8' });
    expect(status.status).toBe(0);
    expect(status.stdout.trim()).toBe('');

    // And assert the binary did write its index (proving analyze actually ran).
    expect(existsSync(join(scratch, '.gitnexus'))).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 6.2: Run the test**

Run: `pnpm vitest run extensions/gitnexus/test/analyze-clean-tree.integration.test.ts`
Expected: PASS (if `gitnexus` binary available; test auto-skips otherwise).

- [ ] **Step 6.3: Commit**

```bash
git add extensions/gitnexus/test/analyze-clean-tree.integration.test.ts
git commit -m "test(gitnexus): integration — analyze leaves git tree clean

Spawns real gitnexus binary with stealth flags in a mktemp scratch repo,
asserts .gitnexus/ index is written and git status --porcelain is empty.
Auto-skipped when binary is not on PATH."
```

---

### Task 7: Run sync script, commit resulting VERSION + skill updates

**Files:**
- Modify: `extensions/gitnexus/skills/VERSION` and zero-to-many files under `extensions/gitnexus/skills/*/SKILL.md`.

- [ ] **Step 7.1: Run sync for real**

Run: `scripts/sync-gitnexus-resources.sh`
When prompted `Apply changes?`, review the diff summary. If it looks correct (MODIFIED entries expected given binary-vs-vendored age gap), answer `y`.

- [ ] **Step 7.2: Review resulting diff**

Run: `git diff --stat extensions/gitnexus/skills/`
Expected: several `SKILL.md` files modified, possibly new directories for `gitnexus-guide` and `gitnexus-cli` (not currently vendored), possibly `gitnexus-pr-review` removed (if binary no longer templates it).

Run: `git diff extensions/gitnexus/skills/ | head -100`
Manually verify content looks sane: skill frontmatter intact, no obvious corruption.

- [ ] **Step 7.3: Commit**

```bash
VERSION="$(cat extensions/gitnexus/skills/VERSION)"
git add extensions/gitnexus/skills/
git commit -m "chore(gitnexus): sync skills to binary v$VERSION"
```

---

### Task 8: Update `extensions/gitnexus/README.md` Local Additions

**Files:**
- Modify: `extensions/gitnexus/README.md` (section `## Local Additions` at the bottom)

- [ ] **Step 8.1: Read the current section**

Run: `grep -n 'Local Additions' extensions/gitnexus/README.md`
Note the line range.

- [ ] **Step 8.2: Append new entries**

Append to the `## Local Additions` section:

```markdown
- `src/stealth-injection.ts` — exports `GITNEXUS_CONTRACT_PROSE`, `buildInjectedSystemPrompt`, `composeAnalyzeArgs`, and `checkSkillDrift`. The `before_agent_start` handler appends the contract prose plus a runtime-derived list of loaded `gitnexus-*` skills to the system prompt. The `/gitnexus analyze` slash command always passes `--skip-agents-md --no-stats` and never passes `--skills`. Purpose: zero working-tree impact from `analyze`. See `docs/superpowers/specs/2026-05-07-gitnexus-stealth-injection-design.md`.
- `skills/VERSION` — single-line binary version that the vendored skills track. Updated only by `scripts/sync-gitnexus-resources.sh`. Drift vs installed binary produces a non-blocking `notify('warning')` at `session_start`.
- Root `.gitignore` entries `.claude/` and `CLAUDE.md` — defense in depth against direct-CLI invocations of `gitnexus analyze` outside pi.
```

- [ ] **Step 8.3: Commit**

```bash
git add extensions/gitnexus/README.md
git commit -m "docs(gitnexus): document stealth-injection additions in README

Note the new src/stealth-injection.ts module, skills/VERSION file, and
root .gitignore entries introduced by the stealth-injection design."
```

---

## Post-implementation verification

- [ ] **Step V.1: Full test suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step V.2: Full typecheck**

Run: `pnpm lint:typecheck`
Expected: PASS.

- [ ] **Step V.3: Live smoke test**

In an interactive pi session inside this repo:
1. Run `/gitnexus analyze`.
2. Run `git status --short`.
Expected: no changes listed. This is the spec's stated goal.

- [ ] **Step V.4: Verify drift notify is silent on match**

Start a fresh pi session.
Expected: no drift notification (VERSION matches binary after Task 7).

- [ ] **Step V.5: Verify drift notify fires on mismatch**

Hand-edit `extensions/gitnexus/skills/VERSION` to `0.0.0`. Restart pi session.
Expected: one `[GitNexus] Vendored skills version 0.0.0 differs from installed binary ...` notification.
Restore the file: `git checkout extensions/gitnexus/skills/VERSION`.

---

## Self-review

**Spec coverage:** Each spec §Component maps to tasks:
- §Component 1 (remove AGENTS.md block) → Task 3
- §Component 2 (expand before_agent_start with prose + runtime skills) → Task 1
- §Component 3 (CLI flag composition) → Task 2
- §Component 4 (.gitignore entries) → Task 3
- §Component 5 (sync script) → Task 5
- §Component 6 (VERSION + drift detect) → Task 4
- §Testing unit #1–#7 → Task 1/2/4 tests
- §Testing integration #8 → Task 6
- §Testing integration #9 (manual sync dry-run) → Task 5 Step 5.3
- §Migration steps → Task 3 Step 3.6 (delete untracked) + Task 7 (first sync run)

**No gaps.**

**Placeholder scan:** No TODOs, TBDs, "add validation", "handle edge cases", or similar. All code blocks complete.

**Type consistency:**
- `buildInjectedSystemPrompt` signature `(args: { base: string; cwd: string; skills?: Array<{ name: string }> })` used in Task 1 tests and Task 1.5 wiring — consistent.
- `composeAnalyzeArgs(baseArgs: string[], userRest?: string[]): string[]` — consistent between Task 2.1, 2.3, 2.5, and Task 6.1 integration test.
- `checkSkillDrift({vendoredVersion, binaryVersion})` → `DriftNotice | null` — consistent Task 4.1/4.3/4.6.
- `notify(message, severity)` severity value `'warning'` — matches existing code at `src/index.ts:230` and round-2 reviewer's explicit correction.

**Three reviewer notes carried in plan:**
1. `?? []` coalescing for optional `skills` → Task 1.3 uses `(args.skills ?? []).filter(...)`. ✓
2. Word-boundary regex in skill-name assertions → Task 1.1 tests use `/\bgitnexus-exploring\b/`. ✓
3. `"warning"` severity → Task 4.3 returns `severity: 'warning'`. ✓
