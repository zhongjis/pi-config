// Provenance: DOX source marker is explicit; prompt wording is original, Pi-native, and intentionally concise.
// The prompt points at live upstream DOX (agent0ai/dox, MIT) instead of embedding the contract, so DOX text is never duplicated here.
export const INIT_DOX_TEMPLATE = `# /init-dox

Install or migrate this project's AGENTS.md docs to the DOX framework. Documentation/process only — no runtime, package, config, lockfile, or toolchain changes unless user args explicitly request broader changes.

## Step 1 — Build context

- DOX source of truth: https://github.com/agent0ai/dox/tree/main (MIT). Adopt as a documentation/process layer, not a package or programming dependency.
- Read the repo README first to learn what DOX is and how the hierarchy works: https://github.com/agent0ai/dox/blob/main/README.md
- Read the DOX contract file — this is the DOX-system text you will install at the project root: https://github.com/agent0ai/dox/blob/main/AGENTS.md
- Pi shortcut: read \`github://agent0ai/dox/README.md\` and \`github://agent0ai/dox/AGENTS.md\` directly with the read tool.
- Raw DOX contract for byte-exact copying: https://raw.githubusercontent.com/agent0ai/dox/main/AGENTS.md
- Do not proceed until both files are read. Follow their hierarchy, child-doc shape, style, and closeout rules for every edit below.

## Step 2 — Modify AGENTS.md

Discover docs with fd. Read the root AGENTS.md and every child AGENTS.md on each target path before editing. Then branch on whether a root AGENTS.md already exists.

The DOX contract text must be reused verbatim — fetch the raw file with the CLI and reuse its bytes; never retype, reword, reformat, or trim it. The only parts you author for this project are the **Child DOX Index** entries and the **User Preferences** section; every other section (the DOX rules) stays byte-for-byte identical to upstream.

### If root AGENTS.md does NOT exist

1. Fetch the DOX contract verbatim into a new project-root AGENTS.md via the CLI, e.g.:
   \`curl -fsSL https://raw.githubusercontent.com/agent0ai/dox/main/AGENTS.md -o AGENTS.md\`
2. Populate the root **Child DOX Index** per DOX rules: list each child AGENTS.md and its scope; if none exist yet, state that root owns all files.
3. Create/rewrite/polish child AGENTS.md files wherever a folder is a durable boundary that warrants one, following DOX rules. Child docs carry local deltas only.

### If root AGENTS.md ALREADY exists

1. Fetch the DOX contract verbatim and prepend its bytes to the top of the existing root AGENTS.md via the CLI, keeping existing content intact below, e.g.:
   \`curl -fsSL https://raw.githubusercontent.com/agent0ai/dox/main/AGENTS.md -o /tmp/dox-agents.md && printf '\\n\\n' | cat /tmp/dox-agents.md - AGENTS.md > AGENTS.md.new && mv AGENTS.md.new AGENTS.md\`
   DOX rules must come first, followed by the existing content unchanged.
2. Populate the root **Child DOX Index** per DOX rules.
3. Rewrite/polish the pre-existing content to strictly follow DOX rules: concise, current, operational; delete stale, duplicate, or contradictory guidance.
4. Create/rewrite/polish child AGENTS.md files wherever warranted, following DOX rules. Child docs carry local deltas only.

## Rules

- Copy the DOX contract byte-for-byte from upstream — never paraphrase, reword, reformat, or trim the DOX rules.
- Read existing AGENTS.md before editing. Never overwrite existing content — prepend the DOX text and preserve what was there.
- Do not duplicate parent rules into child docs.
- If ownership or a destructive migration is ambiguous, ask which doc owns the path before overwriting or deleting.
- Keep locally authored wording (Child DOX Index, child docs) concise and operational.

## Output

Report:
  === init-dox Complete ===
  Mode: installed | migrated
  Root AGENTS.md: created | prepended
  Child AGENTS.md created/updated: N
  Asked user: yes/no
  Notes: blockers, ownership questions, or docs intentionally unchanged
`;
