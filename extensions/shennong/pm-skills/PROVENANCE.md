# Vendored PM skills — provenance

These skills are vendored from an upstream open-source project and gated to the
`神農 (shennong)` mode by the `shennong` extension (see `../index.ts`).

| Field | Value |
|-------|-------|
| Upstream | https://github.com/phuryn/pm-skills |
| Pinned commit | `18468a95b427e70e258b51389796367c6f684e7d` |
| License | MIT — © 2026 Paweł Huryn (see `./LICENSE`) |
| Vendored on | 2026-07-04 |

## What was vendored

The `skills/` subtrees of 7 of the 9 upstream plugins (62 skills total):

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
- **`commands/`** and **`.claude-plugin/`** from every plugin — Claude Code
  slash-command workflows and plugin manifests that pi does not execute. Skill
  chaining is handled by the `神農` mode prompt instead.

## Updating

Skills are pinned to the commit above. The `shennong` extension checks the upstream
HEAD when the mode is entered and surfaces a toast if it has advanced. To sync, use
the `pi-extension-vendoring` / `skill-maintainer` workflow: re-clone at the new SHA,
re-copy the 7 `skills/` subtrees, re-run the collision + frontmatter audit, and bump
the pinned commit here and in `../package.json` (`piVendor.commit`).
