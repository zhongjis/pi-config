## Purpose

Provide the complete vendored imagegen tool, `/img` workflows and local browser studio.

## Ownership

- Owns runtime source, local tests and upstream provenance.

## Local Contracts

- You MUST preserve upstream workflows and studio structure; limit studio changes to provider/model controls and their request/history wiring.
- Generation MUST select `gpt-image-2`, `gpt-image-2.5` or `gpt-image-2.5-sunburst` through Pi-resolved `openai` or `cliproxyapi` credentials. OpenAI subscription authorization is provider-controlled; NEVER report rejected requests as supported generation.
- OpenAI selection MUST require official ChatGPT OAuth and the official API endpoint. Proxy selection MUST use only proxy credentials. NEVER replay a request, switch providers or introduce API-key billing implicitly.
- Model visibility MUST require an exact supported `imagegen.generate` chain candidate and local authentication of generation's first registered provider anchor; OpenAI additionally requires OAuth and the official model base URL. NEVER use session fallback, fuzzy resolution, credential refresh or network discovery for visibility.
- Session/agent start MUST withdraw ineligible tools with hidden exposure. NEVER re-register or activate eligible tools within that instance; restoration requires `/reload` or restart under normal Mode/subagent policy. Manual `/img` workflows MUST remain available; local eligibility does not prove upstream entitlement.
- You MUST preserve [license evidence](UPSTREAM-LICENSE.md) and the pinned [README provenance](README.md#upstream).
- You MUST use `index.ts` as the sole extension discovery entrypoint.
- Studio HTML (`/`, `/studio`), `/api/*` and `/events` MUST require the URL token before side effects; retain Host checks and reject any present nonmatching Origin, including `null`. Absent Origin is allowed. This browser boundary is not a sandbox against local same-user processes.
- You NEVER use live credentials or subscription requests in automated regression tests.

## Work Guidance

- On upstream sync, you MUST preserve every divergence in the [README Local Tweaks checklist](README.md#local-tweaks).
- You SHOULD preserve upstream style; restrict patches to provider/model support, runtime compatibility and studio access checks.
- You MUST isolate tests in a temporary agent directory and restore mocks.

## Verification

- `pnpm exec vitest run --project unit extensions/imagegen/index.test.ts`
- `pnpm exec tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node extensions/imagegen/index.ts extensions/imagegen/index.test.ts`
- `biome check extensions/imagegen/index.ts extensions/imagegen/index.test.ts` (repository formatter is disabled).

## Child DOX Index

- None.
