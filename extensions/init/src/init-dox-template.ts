// Provenance: DOX source marker is explicit; prompt wording is original, Pi-native, and intentionally concise.
// The prompt points at live upstream DOX (agent0ai/dox, MIT) instead of embedding the contract, so DOX text is never duplicated here.
export const INIT_DOX_TEMPLATE = `# /init-dox

Install, upgrade, or migrate this project's AGENTS.md docs to the DOX framework. Documentation/process only — no runtime, package, config, lockfile, or toolchain changes unless user args explicitly request broader changes.

## Step 1 — Build context

- DOX source of truth: https://github.com/agent0ai/dox/tree/main (MIT). Adopt as a documentation/process layer, not a package or programming dependency.
- Read the repo README first to learn what DOX is and how the hierarchy works: https://github.com/agent0ai/dox/blob/main/README.md
- Read the DOX contract file — this is the DOX-system text you will install at the project root: https://github.com/agent0ai/dox/blob/main/AGENTS.md
- Pi shortcut: read \`github://agent0ai/dox/README.md\` and \`github://agent0ai/dox/AGENTS.md\` directly with the read tool.
- Do not proceed until both files are read. Follow their hierarchy, child-doc shape, style, and closeout rules for every edit below.

## Step 2 — Fetch upstream and compute the version tag

The DOX contract text must be reused verbatim — fetch the raw file with the CLI and reuse its bytes; never retype, reword, reformat, or trim it. Compute its sha256 so the install carries a version tag for future upgrade detection:

    curl -fsSL https://raw.githubusercontent.com/agent0ai/dox/main/AGENTS.md -o /tmp/dox-agents.md
    DOX_SHA=$(shasum -a 256 /tmp/dox-agents.md | cut -d' ' -f1)

The version tag is a single HTML comment placed directly ABOVE the verbatim DOX block, never inside it (so the block stays byte-for-byte identical to upstream):

    <!-- dox-source: agent0ai/dox@main sha256:$DOX_SHA -->

## Step 3 — Classify state and resolve the action

Discover docs with fd. Read the root AGENTS.md and every child AGENTS.md on each target path. Locate the version tag \`<!-- dox-source: agent0ai/dox@main sha256:... -->\` if present. Resolve exactly one action from this table — do not edit anything yet:

| Root AGENTS.md state | Resolved action |
|----------------------|-----------------|
| absent | Create — write the tag + verbatim DOX contract + a Child DOX Index. |
| tag present, sha matches upstream | Unchanged — DOX contract is current; only the Child DOX Index and child docs may need a refresh. |
| tag present, sha differs | Upgrade — replace the tagged DOX-rules block with the current verbatim contract and restamp the tag. |
| tag missing, a DOX block is present (older/paraphrased/adapted) | Migrate — replace the legacy DOX-rules block with the tag + verbatim contract. |
| tag missing, no DOX block | Prepend — add the tag + verbatim contract to the top, keep existing content intact below. |

Ambiguity guard: if a legacy DOX block is interleaved with project content and cannot be cleanly separated, do not guess — surface it in the decision gate below.

## Step 4 — Decision gate (human approval)

Stop before touching any file. Present the resolved plan and get explicit human approval:

- resolved action (Create / Unchanged / Upgrade / Migrate / Prepend)
- root AGENTS.md path and how it changes (created / block replaced / prepended / untouched)
- for Upgrade: the installed tag sha vs the current upstream sha
- child AGENTS.md files to be created or rewritten
- any ambiguity from Step 3 that needs a human decision

Wait for explicit approval. If the user rejects or asks for changes, adjust the plan and re-confirm. If the resolved plan is a pure no-op (Unchanged with no child-doc edits), report it and finish without prompting.

## Step 5 — Apply the approved plan

Execute only the approved action.

- Root AGENTS.md: perform the Create / Upgrade / Migrate / Prepend using the CLI-fetched bytes (/tmp/dox-agents.md). Only the DOX-rules sections are copied byte-for-byte; the **Child DOX Index** and **User Preferences** sections are project-authored — populate them for this repo and preserve existing entries across upgrades.
- Idempotency: after a run the file carries a current tag, so re-running with no upstream change resolves to Unchanged and never duplicates the DOX block.
- Child docs: populate the root **Child DOX Index** per DOX rules (list each child AGENTS.md and its scope; if none exist yet, state that root owns all files). Create/rewrite/polish child AGENTS.md files wherever a folder is a durable boundary that warrants one; child docs carry local deltas only and do not duplicate parent rules.

## Output

Report:
  === init-dox Complete ===
  Mode: installed | upgraded | migrated | unchanged
  Root AGENTS.md: created | replaced | prepended | unchanged
  DOX source: agent0ai/dox@main sha256:<hex>
  Approved by user: yes | n/a (no-op)
  Child AGENTS.md created/updated: N
  Notes: blockers, ownership questions, or docs intentionally unchanged
`;
