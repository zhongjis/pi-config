# Dashboard design source lock

## Working root

This module's sole working root is `self-evolve/`.

Guardrails for follow-up work:
- keep module notes and any future design docs under `self-evolve/`
- do not create or edit repo-root `PRODUCT.md`
- do not create or edit repo-root `DESIGN.md`

## Upstream inspection lock

Inspected upstream repo via git-native clone:
- repo: `https://github.com/VoltAgent/awesome-design-md`
- exact chosen upstream file path: `design-md/sentry/README.md`
- chosen file currently points to: `https://getdesign.md/sentry/design-md`

Inspection note:
- in the current upstream git tree, per-site entries present as `design-md/<site>/README.md` pointer files
- the root `README.md` contains the useful shortlist descriptions that distinguish product/dashboard-oriented candidates

## Shortlist

### Chosen
- `design-md/sentry/README.md`
  - why it won: the upstream root `README.md` describes Sentry as `Error monitoring. Dark dashboard, data-dense, pink-purple accent.` This is the clearest direct fit for a dense product/dashboard UI.
  - why the exact file path is locked: the site-specific upstream file exists at `design-md/sentry/README.md` and is the current awesome-design-md pointer for that design source.

### Rejected alternatives
- `design-md/posthog/README.md`
  - shortlist reason: the upstream root `README.md` describes PostHog as `Product analytics. Playful hedgehog branding, developer-friendly dark UI.`
  - rejection reason: product analytics is relevant, but the documented playful brand direction is a weaker fit than Sentry's explicitly data-dense dashboard framing.

- `design-md/kraken/README.md`
  - shortlist reason: the upstream root `README.md` describes Kraken as `Crypto trading platform. Purple-accented dark UI, data-dense dashboards.`
  - rejection reason: it matches dashboard density, but the trading-platform framing risks pulling the module toward finance/trading affordances instead of a general operator/product dashboard.

## Decision

For this module, cite `design-md/sentry/README.md` as the exact upstream awesome-design-md source lock.

Concise rationale for future reference:
- choose Sentry because the upstream collection explicitly labels it `dark dashboard, data-dense`, which is the strongest inspected match for dense product/dashboard UI among the shortlisted candidates.
