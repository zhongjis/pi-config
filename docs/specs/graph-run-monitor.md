# Graph Run Monitor — Observability Panel

Status: draft

Owner: docs/AGENTS.md (specs bucket)

Related: [agent-graph-reusable-workflows.md](agent-graph-reusable-workflows.md) · [../guides/agent-graph-implementation.md](../guides/agent-graph-implementation.md) · reference: [jc01rho/omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag)

## Problem Statement

I run `agent_graph` runs from Pi and watch them in the Herdr side pane
(`/graph-runs`). The pane renders one run as a flat, phase-grouped roster. As an
operator I cannot answer the questions I actually have while a run is live:

- I often have **several runs going at once**, but the pane only shows one and I
  cannot switch to the others or even see that they exist.
- When a node sits idle I cannot tell **what it is waiting on**, and when a node
  fails I cannot tell **what that failure took down** with it.
- The run is genuinely a DAG — the adapter already computes each node's
  topological stage and its forward dependencies — but none of that dependency
  structure is shown.

Pass 1 already fixed the pane's wasted vertical space (the frame now fills the
pane height) and renamed the surface to `/graph-runs`. What remains is turning
the pane from a task list into a **run observability panel**.

## Solution

Make the pane a run observability panel with three stacked zones, purpose-built
for triage in a narrow (~35% width) terminal column:

1. **Run switcher** — the pane defaults to the **last active run** (newest live,
   else newest overall) and shows the other runs as health dots; `←/→` browses
   between active and recent runs. Concurrent runs are never invisible.
2. **Node roster, in dependency order** — nodes grouped by **topological stage**
   (the stage *is* the dependency order), each stage with an `N/M` rollup and a
   one-line summary strip of live counts (running / queued / done / failed). A
   blocked node shows an inline `waits: …` cue.
3. **Node detail** for the selected node — status · agent · model, then
   **Waits on (upstream)** listing each dependency and its current state, and
   **Unblocks (downstream)** listing what this node gates, plus outcome/error and
   prompt/runtime facts.

Dependency is shown as **stage order + upstream/downstream relationship lists**,
which reads more clearly than node-link ASCII art in a narrow pane. A full
DAG-card-and-connectors graph view is deliberately deferred to a future optional
toggle (see Out of Scope), because dependency comprehension does not require it.

Scope is split into two milestones:

- **v1** — run switcher, stage-ordered roster + summary strip, node detail with
  upstream/downstream. Fills the pane height (pass 1 wired `rows` through).
- **v1.5** — roster **filter** (running / failed / all), **stage collapse**, and
  failure **blast radius** (a failed node highlights the downstream nodes it
  skipped).

## User Stories

1. As an operator, I want the pane to open on my most recently active run, so I
   see what is happening now without choosing anything.
2. As an operator running several graphs at once, I want to see that other runs
   exist and their health at a glance, so no run is silently hidden.
3. As an operator, I want to switch to another active or recent run with `←/→`,
   so I can check on any run without leaving the pane.
4. As an operator, I want each run's switcher entry to show its status and
   progress (running/failed/done, `done/total`, elapsed), so I can triage across
   runs quickly.
5. As an operator, I want nodes grouped by dependency stage, so I read the
   graph's execution order top to bottom.
6. As an operator, I want each stage to show a `done/total` rollup, so I see how
   far the run has progressed through that layer.
7. As an operator, I want a summary strip of live counts (running / queued /
   done / failed) for the run, so I get the observability read in one line.
8. As an operator, I want each node row to show its state glyph, id, agent/model,
   and live activity (elapsed / tool calls) or its outcome, so a row is
   self-describing.
9. As an operator, I want a blocked node to show what it is waiting on inline, so
   I understand a stall without opening detail.
10. As an operator, I want to select a node and see its detail, so I can inspect
    one node deeply.
11. As an operator inspecting a node, I want an explicit **Waits on (upstream)**
    list with each dependency's current state, so I know exactly what is holding
    the node back.
12. As an operator inspecting a node, I want an **Unblocks (downstream)** list, so
    I know what depends on this node finishing.
13. As an operator, I want a failed node's detail to show its error and the
    downstream nodes that got skipped because of it, so I see the blast radius.
14. As an operator, I want to open the selected node's full conversation (`c`),
    so I can read what the agent actually did.
15. As an operator with a large graph, I want to filter the roster to just
    running or failed nodes, so a big run stays legible.
16. As an operator, I want to collapse a stage, so I can hide completed layers
    and focus on the active frontier.
17. As an operator, I want failed and skipped nodes color-coded distinctly, so
    problems are obvious at a glance.
18. As an operator on a terminal without box-drawing/Unicode, I want an ASCII
    rendering, so the panel is still readable.
19. As an operator, I want the panel to fill the pane height with a scrollable
    body, so large runs are navigable and the pane is not mostly blank.
20. As an operator, I want the `/agents → Graph runs` overlay to keep working
    exactly as before, so this change does not disturb the existing inspector.
21. As an operator, if the panel ever fails to render, I want the pane to fall
    back to the existing roster rather than showing nothing, so I never lose
    visibility.
22. As an operator, I want a run that has finished to remain inspectable in the
    switcher, so I can review a completed or failed run after it ends.

## Implementation Decisions

### Seam and module boundary

- The panel is a **new pure renderer + key handler**, not a change to the shared
  `layoutWorkflowDialog`. New module `src/ui/observability-panel.ts` exports
  `renderPanelLines(...)`, `applyPanelKey(...)`, and `initialPanelState()`, all
  pure and terminal-free, emitting `WorkflowCardLine[]`. This is the **single
  seam** for testing (prior art: the roster's own pure layout tests).
- The panel reuses existing pure helpers from `progress.ts` (`collapse`,
  `buildPhaseGroups`, `displayState`, `header`, `formatDuration`) and the glyph
  vocabulary / `dialogRowGlyph` from `workflow-dialog.ts`, and flows through the
  pane's existing `styleWorkflowCardLines(…, PANE_ANSI_THEME)` + `clampLine`
  width pipeline unchanged (CJK/emoji-safe via pi-tui `visibleWidth`).
- `src/graph/pane/render.ts` gains a thin `renderObservabilityPaneLines` wrapper
  mirroring `renderWorkflowPaneLines`. `renderWorkflowPaneLines`, `applyPaneKey`,
  and the roster `WorkflowDialogState` are **left untouched**.
- `src/graph/pane/manager.ts` renders the panel as the pane's **default** view,
  holds the panel state and the run list, routes forwarded keys to
  `applyPanelKey`, and on a render throw falls back to `renderWorkflowPaneLines`
  (the current roster). The roster path and the manager's existing `paneState`
  field stay so the overlay and the WIP baseline are undisturbed.

### Invariants (must hold)

- The `/agents → Graph runs` overlay (`WorkflowDialog`) is byte-for-byte
  unchanged.
- The 8 known WIP `applyPaneKey`/manager tests (they assert an abandoned
  `selectedPhase` / `level:"phases"→"agent"` roster-nav model) keep compiling and
  keep their exact current baseline — the panel does not touch that API. Their
  reconciliation is a tracked decision (below), not part of shipping the panel.
- Every rendered line stays within the requested width; the body fills exactly
  the pane height (header + scrolled window + footer), reusing pass 1's `rows`.

### Topology data (the one adapter change)

- Add two structured fields to `WorkflowAgentEntry` in `progress.ts`:
  `deps?: string[]` (forward, non-loop predecessors) and
  `dependents?: string[]` (forward successors — the inverse).
- `GraphRunReporter` (`graph-run-adapter.ts`) sets both from the `deps` map it
  already computes (`dependents` is the inverse of `deps`). No new topology
  crosses the adapter boundary beyond these two arrays; the existing
  `promptPreview: "depends on: …"` string stays for compatibility.
- Upstream state is looked up by joining `deps` against `collapse(progress)`
  (each dep's `displayState`). Downstream/blast-radius joins `dependents`.

### Panel state (pane-local)

```
interface PanelState {
  selectedNodeId?: string;              // node selection
  runIndex: number;                     // which run the switcher points at
  filter: "all" | "running" | "failed"; // v1.5
  collapsedStages: Set<number>;         // v1.5
  scroll: number;                       // body scroll offset
}
```

The manager owns one `PanelState` plus the run list. Default `runIndex` resolves
to the last active run (newest live, else newest overall — the existing
`pickTask` rule). Switching runs resets `selectedNodeId`/`scroll`.

### Keys (panel view)

- `↑↓` / `j`/`k`, `pageUp`/`pageDown` — move node selection / scroll body.
- `←` / `→` — switch run.
- `f` — cycle filter all → running → failed (v1.5).
- `space` / `enter` — toggle collapse of the selected node's stage (v1.5).
- `c` — open the selected node's conversation (only if it has a `recordId`).
- `esc` / `q` — close the pane (same contract as the roster).

The panel is **read-only** like the roster: it never wires kill/pause/skip/retry.

### Rendering (top to bottom)

1. **Run switcher** — `‹ <name> ›  <status-dot> <status>  <i>/<n>`; a second
   line lists other runs as `<dot> <name>` health chips; `←→ run` hint.
2. **Header stats** — reuse `header()`: `<done>/<total> nodes · <elapsed>` plus a
   terminal suffix (`· done`/`· failed`/`· stopped`) when the run has ended.
3. **Summary strip** — colored counts `● running N · ◌ queued N · ✓ done N ·
   ✗ failed N`, each in its state color.
4. **Roster by stage** — `Stage k ── N/M` headers (dependency order); rows via
   `dialogRowGlyph`: `<sel> <glyph> <id>  <state>  <model>` with live activity or
   `waits: …`. Selected row marked with the accent pointer.
5. **Node detail** — `<state> · <agentType> · <model>`; **Waits on (upstream)**
   (`<glyph> <depId> <state>` per dep); **Unblocks (downstream)** (`→ a → b`);
   Outcome/Error preview; Prompt preview; runtime facts (tokens / tool calls /
   duration). A failed node's detail adds **Blast radius** (downstream skipped).
6. **Footer** — `● live`/`○ done` + scroll range + control hints.

State→glyph/color reuses the existing vocabulary (`success`/`error`/`warning`/
`dim`/`accent`/`muted`); an ASCII tier reuses `ASCII_DIALOG_GLYPHS` gated on the
pane's `ascii` flag.

### WIP-test reconciliation (tracked decision)

The 8 red baseline tests target an in-pane roster drill-down (`selectedPhase`,
`level:"phases"→"agent"`) that was never implemented and is superseded by the
panel's own navigation. Decision: **replace** them with panel tests once the
panel ships, in a clearly-labeled commit, rather than leaving permanent red or
silently deleting. Until then they stay at baseline (the panel does not touch
their API).

## Testing Decisions

- A good test here exercises **external behavior** through the one seam
  (`observability-panel.ts`): given a `WorkflowDialogSource` (+ run list + panel
  state), assert on the produced lines / next state — never on private layout
  internals. Prior art: `test/workflow-dialog.test.ts` (pure layout/key tests
  over `layoutWorkflowDialog`).
- New `test/observability-panel.test.ts` (pure, no terminal) covers: stage
  layering from entries; upstream state join from `deps`; downstream/blast-radius
  from `dependents`; summary-strip counts; run-switcher selection and default
  last-active resolution; node selection / scroll key transitions; filter and
  stage-collapse transitions (v1.5); ASCII tier; empty / no-run / single-node
  edge cases; and render-throw → roster fallback (asserted at the manager or
  render wrapper).
- Gate every slice on `tsc --noEmit`, `biome check`, and
  `pnpm test:extensions` staying at the 8-failure baseline (no new failures).

## Out of Scope

- **Full DAG graph view** — layered node cards with drawn connectors (the
  `omo-herdr-dag` `graphLines`/connector-grid style). Deferred to a future
  optional `g` toggle; the panel already conveys dependencies via stage order +
  relationship lists.
- **Loops and conditional edges** — the panel shows the forward DAG only, matching
  the adapter's forward, non-loop `deps`. Drawing back-edges/guards needs the
  reporter to carry `loop`/`when`.
- **Promoting the panel to the `/agents → Graph runs` overlay** — pane-first only.
- **Simultaneously auto-following multiple runs** — one primary run is rendered;
  others are reachable via the switcher, not rendered at once.
- Renaming internal types / the `workflowsEnabled` key / filenames (done/kept in
  pass 1).

## Further Notes

- The panel supersedes the pane's roster as the default view; the roster remains
  as the untouched shared overlay layout and the on-throw fallback.
- Build order: v1 = topology fields + panel renderer + run switcher + relationship
  detail (walking skeleton first: fields + a stacked roster that paints in the
  pane and fills height without disturbing the roster/overlay/WIP tests), then
  v1.5 = filter + stage collapse + blast radius, then harden (ASCII tier, width/
  CJK safety, tests, throw→roster fallback).
