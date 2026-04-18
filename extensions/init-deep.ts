import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const INIT_DEEP_TEMPLATE = `# /init-deep

Generate hierarchical AGENTS.md files. Root + complexity-scored subdirectories.

## Usage

\`\`\`
/init-deep                      # Update mode: modify existing + create new where warranted
/init-deep --create-new         # Read existing → remove all → regenerate from scratch
/init-deep --max-depth=2        # Limit directory depth (default: 3)
\`\`\`

---

## Workflow (High-Level)

1. **Discovery + Analysis** (concurrent)
   - Fire background chengfeng agents immediately
   - Main session: bash structure + LSP codemap + read existing AGENTS.md
2. **Score & Decide** — Determine AGENTS.md locations from merged findings
3. **Generate** — Root first, then subdirs in parallel
4. **Review** — Deduplicate, trim, validate

<critical>
**Create pi-tasks for ALL phases. Mark in_progress → completed in real-time.**

\`\`\`
TaskCreate({ subject: "Discovery: fire explore agents + LSP codemap + read existing", description: "Phase 1" })
TaskCreate({ subject: "Scoring: score directories, determine AGENTS.md locations", description: "Phase 2" })
TaskCreate({ subject: "Generate: create AGENTS.md files (root + subdirs)", description: "Phase 3" })
TaskCreate({ subject: "Review: deduplicate, validate, trim", description: "Phase 4" })
\`\`\`
</critical>

---

## Phase 1: Discovery + Analysis (Concurrent)

**Mark discovery task as in_progress.**

### Fire Background Explore Agents IMMEDIATELY

Don't wait — these run async while main session works.

\`\`\`
// Fire all at once via chengfeng, collect results later
Agent(subagent_type="chengfeng", description="Explore project structure", run_in_background=true, prompt="Project structure: PREDICT standard patterns for detected language → REPORT deviations only")
Agent(subagent_type="chengfeng", description="Find entry points", run_in_background=true, prompt="Entry points: FIND main files → REPORT non-standard organization")
Agent(subagent_type="chengfeng", description="Find conventions", run_in_background=true, prompt="Conventions: FIND config files (.eslintrc, pyproject.toml, .editorconfig, tsconfig) → REPORT project-specific rules")
Agent(subagent_type="chengfeng", description="Find anti-patterns", run_in_background=true, prompt="Anti-patterns: FIND 'DO NOT', 'NEVER', 'ALWAYS', 'DEPRECATED' comments → LIST forbidden patterns")
Agent(subagent_type="chengfeng", description="Explore build/CI", run_in_background=true, prompt="Build/CI: FIND .github/workflows, Makefile, CI configs → REPORT non-standard patterns")
Agent(subagent_type="chengfeng", description="Find test patterns", run_in_background=true, prompt="Test patterns: FIND test configs, test structure → REPORT unique conventions")
\`\`\`

<dynamic-agents>
**DYNAMIC AGENT SPAWNING**: After bash analysis, spawn ADDITIONAL chengfeng agents based on project scale:

| Factor | Threshold | Additional Agents |
|--------|-----------|-------------------|
| **Total files** | >100 | +1 per 100 files |
| **Total lines** | >10k | +1 per 10k lines |
| **Directory depth** | ≥4 | +2 for deep exploration |
| **Large files (>500 lines)** | >10 files | +1 for complexity hotspots |
| **Monorepo** | detected | +1 per package/workspace |
| **Multiple languages** | >1 | +1 per language |

\`\`\`bash
# Measure project scale first
total_files=$(find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | wc -l)
total_lines=$(find . -type f \\( -name "*.ts" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.scala" \\) -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | tail -1 | awk '{print $1}')
large_files=$(find . -type f \\( -name "*.ts" -o -name "*.py" \\) -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | awk '$1 > 500 {count++} END {print count+0}')
max_depth=$(find . -type d -not -path '*/node_modules/*' -not -path '*/.git/*' | awk -F/ '{print NF}' | sort -rn | head -1)
\`\`\`
</dynamic-agents>

### Main Session: Concurrent Analysis

**While background agents run**, main session does:

#### 1. Structural Analysis via tools

\`\`\`
// Use code_overview for quick structural snapshot
code_overview({ depth: 3 })

// Directory depth + file counts
bash: find . -type d -not -path '*/\\.*' -not -path '*/node_modules/*' -not -path '*/venv/*' -not -path '*/dist/*' -not -path '*/build/*' | awk -F/ '{print NF-1}' | sort -n | uniq -c

// Files per directory (top 30)
bash: find . -type f -not -path '*/\\.*' -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -30

// Code concentration by extension
bash: find . -type f \\( -name "*.py" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.go" -o -name "*.rs" -o -name "*.scala" -o -name "*.java" \\) -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20

// Existing AGENTS.md / CLAUDE.md
find: { pattern: "AGENTS.md" }
find: { pattern: "CLAUDE.md" }
\`\`\`

#### 2. Read Existing AGENTS.md
\`\`\`
For each existing file found:
  read(path=file)
  Extract: key insights, conventions, anti-patterns
  Store in EXISTING_AGENTS map
\`\`\`

If \`--create-new\`: Read all existing first (preserve context) → then delete all → regenerate.

#### 3. LSP Codemap (if available)
\`\`\`
// Entry points (parallel)
lsp_symbols(path="src/index.ts")
lsp_symbols(path="main.py")

// Key symbols (parallel)
lsp_symbols(query="class")
lsp_symbols(query="interface")

// Centrality for top exports
lsp_references(path="...", line=X, character=Y)
\`\`\`

**LSP Fallback**: If unavailable, rely on chengfeng agents + code_search.

### Collect Background Results

\`\`\`
// After main session analysis done, collect all chengfeng results
get_subagent_result(agent_id="...")  // for each launched agent
\`\`\`

**Merge: bash + LSP + existing + explore findings. Mark discovery task as completed.**

---

## Phase 2: Scoring & Location Decision

**Mark scoring task as in_progress.**

### Scoring Matrix

| Factor | Weight | High Threshold | Source |
|--------|--------|----------------|--------|
| File count | 3x | >20 | bash |
| Subdir count | 2x | >5 | bash |
| Code ratio | 2x | >70% | bash |
| Unique patterns | 1x | Has own config | chengfeng |
| Module boundary | 2x | Has index.ts/__init__.py | bash |
| Symbol density | 2x | >30 symbols | LSP |
| Export count | 2x | >10 exports | LSP |
| Reference centrality | 3x | >20 refs | LSP |

### Decision Rules

| Score | Action |
|-------|--------|
| **Root (.)** | ALWAYS create |
| **>15** | Create AGENTS.md |
| **8-15** | Create if distinct domain |
| **<8** | Skip (parent covers) |

### Output
\`\`\`
AGENTS_LOCATIONS = [
  { path: ".", type: "root" },
  { path: "src/hooks", score: 18, reason: "high complexity" },
  { path: "src/api", score: 12, reason: "distinct domain" }
]
\`\`\`

**Mark scoring task as completed.**

---

## Phase 3: Generate AGENTS.md

**Mark generate task as in_progress.**

<critical>
**File Writing Rule**: If AGENTS.md already exists at the target path → use \`edit\` tool. If it does NOT exist → use \`write\` tool.
NEVER use write to overwrite an existing file. ALWAYS check existence first via \`read\` or discovery results.
</critical>

### Root AGENTS.md (Full Treatment)

\`\`\`markdown
# {PROJECT_NAME}

**Generated:** {TIMESTAMP}
**Commit:** {SHORT_SHA}
**Branch:** {BRANCH}

## Overview
{1-2 sentences: what this project does + core stack}

## Structure
\\\`\\\`\\\`
{root}/
├── {dir}/    # {non-obvious purpose only}
└── {entry}
\\\`\\\`\\\`

## Where to Look
| Task | Location | Notes |
|------|----------|-------|

## Code Map
{From LSP - skip if unavailable or project <10 files}

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|

## Conventions
{ONLY deviations from standard — not obvious stuff}

## Anti-Patterns (This Project)
{Explicitly forbidden here — from comments, existing docs, config}

## Unique Styles
{Project-specific patterns that differ from ecosystem norms}

## Commands
\\\`\\\`\\\`bash
{dev/test/build/lint — exact commands from package.json, Makefile, etc.}
\\\`\\\`\\\`

## Gotchas
{Non-obvious traps, workarounds, known issues}
\`\`\`

**Quality gates**: 50-150 lines, no generic advice, no obvious info.

### Subdirectory AGENTS.md (Parallel via jintong)

Launch writing tasks for each scored location:

\`\`\`
for loc in AGENTS_LOCATIONS (except root):
  Agent(subagent_type="jintong", description="Generate AGENTS.md for {loc.path}", prompt=\`
    TASK: Generate AGENTS.md for: \${loc.path}
    EXPECTED OUTCOME: AGENTS.md file written at \${loc.path}/AGENTS.md
    MUST DO:
    - 30-80 lines max
    - NEVER repeat parent AGENTS.md content
    - Include: OVERVIEW (1 line), STRUCTURE (if >5 subdirs), WHERE TO LOOK, CONVENTIONS (if different from parent), ANTI-PATTERNS
    - Use telegraphic style — fragments OK, no filler
    - Match existing code style in that directory
    MUST NOT DO:
    - Generic advice that applies to ALL projects
    - Duplicate info from root AGENTS.md
    - Verbose prose
    CONTEXT: {discovery findings for this directory}
  \`)
\`\`\`

**Wait for all. Mark generate task as completed.**

---

## Phase 4: Review & Deduplicate

**Mark review task as in_progress.**

For each generated file:
- Remove generic advice (anything true of ALL codebases)
- Remove parent duplicates (diff child vs parent, delete overlap)
- Trim to size limits (root: 50-150 lines, subdirs: 30-80 lines)
- Verify telegraphic style — no filler words, no "This directory contains..."
- Run lsp_diagnostics on any modified source files (sanity check)

**Mark review task as completed.**

---

## Final Report

\`\`\`
=== init-deep Complete ===

Mode: {update | create-new}

Files:
  [OK] ./AGENTS.md (root, {N} lines)
  [OK] ./src/hooks/AGENTS.md ({N} lines)

Dirs Analyzed: {N}
AGENTS.md Created: {N}
AGENTS.md Updated: {N}

Hierarchy:
  ./AGENTS.md
  └── src/hooks/AGENTS.md
\`\`\`

---

## Best Practices Applied

These rules are based on research into effective AGENTS.md files:

1. **Precision > vagueness** — specific roles, exact commands, concrete boundaries
2. **Commands are highest-value** — exact build/test/lint commands matter most
3. **Minimal mode** — verbose context REDUCES task success; keep it tight
4. **Telegraphic style** — fragments, tables, lists. No prose paragraphs.
5. **Tiered architecture** — root covers project-wide; subdirs cover local-only concerns
6. **Child never repeats parent** — deduplicate aggressively
7. **Three categories of rules**: "Always", "Ask First", "Never"
8. **No generic advice** — remove anything true of ALL codebases

---

## Anti-Patterns

- **Static agent count**: MUST vary agents based on project size/depth
- **Sequential execution**: MUST parallel (chengfeng + LSP concurrent)
- **Ignoring existing**: ALWAYS read existing first, even with --create-new
- **Over-documenting**: Not every dir needs AGENTS.md
- **Redundancy**: Child never repeats parent
- **Generic content**: Remove anything that applies to ALL projects
- **Verbose style**: Telegraphic or die`;

export default function initDeepExtension(pi: ExtensionAPI): void {
  pi.registerCommand("init-deep", {
    description:
      "Generate hierarchical AGENTS.md knowledge base for the current project",
    handler: async (args: string, ctx) => {
      const userArgs = (args || "").trim();
      const instruction = userArgs
        ? `<user-request>${userArgs}</user-request>`
        : "";

      pi.sendMessage(
        {
          content: `<command-instruction>\n${INIT_DEEP_TEMPLATE}\n</command-instruction>\n\n${instruction}`,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );

      if (ctx.hasUI) {
        ctx.ui.notify("init-deep started — generating AGENTS.md hierarchy…", "info");
      }
    },
  });
}
