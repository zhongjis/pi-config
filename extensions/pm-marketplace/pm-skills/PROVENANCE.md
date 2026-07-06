# Vendored PM skills — provenance

These skills are vendored from an upstream open-source project and gated to the
`神農 (shennong)` mode by the `pm-marketplace` extension (see `../index.ts`).

| Field | Value |
|-------|-------|
| Upstream | https://github.com/phuryn/pm-skills |
| Pinned commit | `18468a95b427e70e258b51389796367c6f684e7d` |
| License | MIT — © 2026 Paweł Huryn (see `./LICENSE`) |
| Vendored on | 2026-07-04 |

## What was vendored

The `skills/` and `commands/` subtrees of 7 of the 9 upstream plugins (62 skills total):

- `pm-product-discovery`
- `pm-product-strategy`
- `pm-execution`
- `pm-market-research`
- `pm-data-analytics`
- `pm-go-to-market`
- `pm-marketing-growth`

## What was intentionally omitted

- **`pm-toolkit`** — resume/NDA/privacy/grammar helpers, unrelated to product work.
- **`pm-ai-shipping`** — code-audit / ship-readiness toolkit (security & performance
  static audits, intended-vs-implemented). Not product-management decision work;
  belongs with a build/ship capability, not this PM mode.
- **`.claude-plugin/`** from every plugin — Claude Code plugin manifests that pi does
  not execute.

## What was additionally vendored

- **`commands/`** from every plugin — Claude Code slash-command workflows are vendored
  alongside `skills/` subtrees. The `pm-marketplace` extension discovers them
  dynamically and registers each as a `/pm:*` command.

## Updating

Skills are pinned to the commit above. The `pm-marketplace` extension checks the upstream
HEAD when the mode is entered and surfaces a toast if it has advanced. To sync, use
the `pi-extension-vendoring` / `skill-maintainer` workflow: re-clone at the new SHA,
re-copy the 7 `skills/` and `commands/` subtrees, re-run the collision + frontmatter audit, and bump
the pinned commit here and in `../package.json` (`piVendor.commit`).
