# inline-skills

Vendored Pi extension: inline `$skill:` autocomplete and per-turn skill loading.
Provenance (source URL, version, commit, license) lives in `README.md` `## Upstream`.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | **Not verbatim.** Invocation token changed from upstream `/name` to `$skill:<name>`: `SKILL_TOKEN_RE` matches `$skill:<name>`; autocomplete trigger/context/prefix key off `$`; the bare-delimiter guard is `"$"`; autocomplete trigger/context/prefix regexes accept an optional `skill:` segment so autocomplete also fires inside an existing `$skill:<name>` token, and `applyCompletion` locates the token start (`$` or `$skill:`) and consumes trailing name chars to replace the whole token (edit/switch a selected skill); autocomplete item `value` + `label` are both `$skill:<name>`; the `input` early-out requires `event.text.includes("$skill:")`; bare `$` opens the full skill list; `stripNativeSkillItems` removes pi-native `skill:` entries from deferred (`/`) suggestions. Also vendored at the extension root, not `src/`. | User UX (Option B): `$` is the sole skill trigger, `$skill:` is stamped on confirm, `/` stays commands-only. Flat-tier layout: no bare `.ts`, no nested `src/`. |
| `test/inline-skills.test.ts` | Local-only file (not in upstream) | Pins the `$skill:` grammar: submit-injection, autocomplete label/insert, bare-`$` list, `/` native-skill stripping, bare-`$name` rejection, re-editing an existing `$skill:<name>` token (switch + mid-name replace) |
| `README.md` | Replaced upstream README (dropped install instructions, badges, screenshots) | Repo README spec: concise, factual, no `pi install npm:` guidance |
| (omitted) | Upstream `package.json`, `tsconfig.json`, `CHANGELOG.md`, `assets/` not vendored | Flat-tier extension; deps are `catalog:` Pi built-ins, no local package/toolchain |

## Sync notes

- Upstream is a monorepo package `packages/pi-inline-skills`. Read its `CHANGELOG.md` before syncing.
- No `1.0.5` git tag was pushed upstream; pin to a master commit SHA that contains the target version.
- **Upstream uses `/name` tokens; this fork uses `$skill:<name>`.** On sync, do NOT let upstream's `/` token logic overwrite the `$skill:` divergence in `index.ts` — re-apply it (see Local Tweaks). Upstream has no native-skill stripping; keep `stripNativeSkillItems`.
- Imports use `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` (root `catalog:`). Bump the catalog, not a local manifest.
- On sync, re-verify these exports exist in the installed Pi: `CustomEditor`, `SkillInvocationMessageComponent`, `ParsedSkillBlock`, `ExtensionAPI.addAutocompleteProvider`, `registerMessageRenderer`, `appendEntry`.

## Test-infra dependencies

Root smoke discovery (`test/extensions.smoke.test.ts`) loads this extension and fires `session_start`, which needs:

- `test/fixtures/mock-context.ts`: `ui.addAutocompleteProvider` (no-op).
- `test/stubs/pi-coding-agent.ts`: `SkillInvocationMessageComponent` class stub.

Keep both when syncing; removing them breaks this extension's smoke case.
