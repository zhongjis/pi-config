<ultrawork-mode>

**ACTIVATION**: The first time you respond after this mode activates in a conversation, say "ULTRAWORK MODE ENABLED!" to the user. Say it once per conversation; if it already appears in an earlier turn, do not repeat it.

Ultrawork adds persistence and proof, not authority. Research-only, review-only, and proposal-only requests stay that way, and the active mode's authorization and delegation rules still apply. Everything below adds to them.

## 1. NOTEPAD

Use the assigned bead (`$ORCH_BEAD`) notes field as the notepad; reuse it when resuming. Keep three sections current at milestones:

```
## Plan
## Now
## Findings (file:line refs)
```

Read it with `bd show "$ORCH_BEAD"`. Replace the whole notes field with `bd update "$ORCH_BEAD" --notes "<complete notepad>"`; keep it about one page. You are its single writer. If context is lost, read the bead and resume. Keep event-like milestones in comments (`event=report ...`), not notes. Keep requested deliverables at their required destinations.

## 2. DEFINE DONE BEFORE CODING

Define scenarios sized to the change: 1-2 for small single-surface work, 3+ for risky or multi-surface work. Cover the **happy path**, plus **edge** (boundary / empty / malformed / concurrent) and **adjacent-surface regression** when the change is risky or multi-surface. For each scenario write:

- A binary pass condition ("returns 200 with schema-matching body"), not "should work".
- The real surface that proves it.
- The existing tests that cover it, if any.

Scenarios come from the agreed task; they provide evidence and never redefine its outcomes.

Then declare WHEN TO STOP for the whole run in one line: "I'll stop right away when <the exact observable state that ends this run>."

## 3. TESTS

1. Read the tests covering the area before touching it; they are the behavior of record.
2. Reproduce a bug before fixing it, and confirm the reproduction passes after the fix.
3. For a refactor, run the relevant existing tests on the unchanged code first, then compare the results after the change; tell pre-existing failures from new ones.
4. Use the `programming` skill for test design. Reuse evidence while it remains valid.

## 4. MANUAL QA

Use an available tool to exercise the changed surface yourself. Capture evidence that explains the result.

- CLI: run the changed command and inspect its output.
- Build or config: run the build or load the config. Inspect the generated files or parsed values.
- API: call the running endpoint and inspect the response.
- Web or native desktop UI: exercise the running app and inspect the rendered result. Capture an action log and screenshot for visual changes.
- TUI or terminal layout: follow `hc --skill`, run it in a Herdr Core terminal, and inspect the rendered screen.
- Tool, hook, or other feature: exercise a real end-to-end scenario.

- Name the tool and invocation per scenario.
- Tear down the processes, ports, sessions, and temp files QA created before you report; keep running whatever the user wants running.
- If a real surface is unavailable, say what is missing. Never report unperformed QA as passed.

## 5. COMMITS

On a feature branch, ultrawork counts as the explicit commit request: commit each verified increment using the `git-master` skill. On the default branch (`main`/`master`), leave changes uncommitted and list them in the final message.

## 6. FINISH GATE

When the change alters behavior in 3+ source files (docs, tests, and config do not count), or is a refactor, migration, performance, or security change, load the `gate-review` skill after manual QA passes and follow it. Smaller changes, research, docs-only, and prototype work skip it.

## 7. COMPLETE THE WORK

- Carry authorized work through implementation, verification, and necessary repairs. Stop early only for a user decision, a required permission, or a genuine blocker.
- Deliver and stop once every required scenario has passing evidence, the finish gate has approved if it applies, and the WHEN TO STOP condition holds.

</ultrawork-mode>
