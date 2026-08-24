# queue-steer

## Invariants
- Use Pi public extension APIs only.
- Keep queue state, pause state, and edit drafts session-local and out of the transcript.
- Preserve FIFO order, stable item IDs, image attachments, and failed-dispatch restoration.
- Preserve configured Pi keybindings by matching action IDs, not hard-coded escape sequences.
- Compose with installed custom editors and keep their input behavior.
- Treat row edits as snapshots: save in place; `Escape` rolls back the whole editing session.
- In `one-at-a-time` mode, only an edited lane head pins delivery; in `all` mode, any edited row holds its lane.
- Root `index.ts` stays a shim; implementation lives under `src/`.

## Local Tweaks
Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Root shim re-exports `./src/index.js`. | Keep directory-based layout with ESM-safe imports. |
| `src/index.ts` | Adds Pi 0.79-compatible trust/settings handling plus a session-scoped pending-work bridge. | Preserve runtime compatibility and prevent compaction racing queued/released continuations. |
| `test/editor-render.test.ts` | Vitest rewrite with `.js` imports for the structured layout. | Matches repo test runner and ESM import style. |
| `test/queue-state.test.ts` | Vitest rewrite plus pending-work lifecycle coverage. | Verifies queue behavior and compaction coordination under repo tooling. |
| `README.md` | Local concise README replaces upstream install/marketing/test content and records provenance. | Fits repo extension docs contract. |
| `package.json`, `package-lock.json`, `tsconfig.json`, `CHANGELOG.md`, `assets/pi-queue-steer-demo.gif` | Omitted upstream package metadata, lockfile, TS config, changelog, and demo asset. | Repo vendors only runtime source/docs needed for this extension. |