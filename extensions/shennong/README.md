# shennong

Vendored PM skills gated to the `神農 (shennong)` mode. Opt-in via `/mode shennong`.

## Upstream

- **Source:** https://github.com/phuryn/pm-skills
- **Commit:** 18468a95b427e70e258b51389796367c6f684e7d
- **License:** MIT — © 2026 Paweł Huryn
- **Vendored on:** 2026-07-04

## What It Does

- Bundles 62 vendored PM skills across 7 plugins under `pm-skills/`.
- `index.ts` registers a `resources_discover` handler that injects all skills
  only when the latest persisted `agent-mode` entry is `shennong`.
- On first context event per session in shennong mode, runs a non-blocking
  background update-check against upstream HEAD (throttled to once per 24 h).
  Surfaces a toast if the pinned commit has fallen behind.
- No context/message injection — the persona lives in `modes/shennong/mode.md`.

## Plugins (62 skills total)

| Plugin | Focus |
|--------|-------|
| `pm-product-discovery` | Discovery research, problem framing, user needs |
| `pm-product-strategy` | Vision, roadmap, strategic decisions |
| `pm-execution` | PRD, job stories, outcome roadmaps |
| `pm-market-research` | Competitive analysis, market sizing |
| `pm-data-analytics` | Metrics, experiments, data storytelling |
| `pm-go-to-market` | Launch plans, positioning, GTM execution |
| `pm-marketing-growth` | Growth loops, acquisition, retention |

Skill provenance and what was intentionally omitted: `pm-skills/PROVENANCE.md`.

## Update-check

When `shennong` mode is active, the extension runs `git ls-remote` against
upstream once per 24 h (fail-silent, hard 5 s timeout). If the remote HEAD
differs from the pinned commit, a toast surfaces with the short SHAs.

To re-vendor: use the `pi-extension-vendoring` / `skill-maintainer` skill.
Bump `piVendor.commit` in `package.json` and `pm-skills/PROVENANCE.md` after sync.

## Files Worth Reading

- `index.ts` — Registers `resources_discover` + update-check logic.
- `package.json` — Declares `pi.extensions` and `piVendor` metadata.
- `pm-skills/PROVENANCE.md` — Vendoring record and what was omitted.
- `pm-skills/LICENSE` — Upstream MIT license.
