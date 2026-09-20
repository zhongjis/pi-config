# Graph Run Monitor — Observability Panel

Status: draft

Owner: docs/AGENTS.md (specs bucket)

Related: [agent-graph-reusable-workflows.md](agent-graph-reusable-workflows.md) · [dynamic-agent-graph-expansion.md](dynamic-agent-graph-expansion.md) · [../guides/agent-graph-implementation.md](../guides/agent-graph-implementation.md) · reference: [jc01rho/omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag)

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
8. As an operator, I want each node row to show a static `*` running or `+` done
   glyph, id, live activity, agent type, and model, so a row is self-describing.
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
23. As an operator, I want a live run's description, main input, and expandable full
    input rendered near its header, so I retain execution context without exposing it in history.
24. As an operator, I want complete retained node output to scroll when expanded, so a
    long result is inspectable rather than tail-clipped.
25. As an operator, I want fanout children to appear as soon as they are materialized, so
    the roster reflects the effective graph rather than only its static definition.
26. As an operator, I want generated evidence tasks grouped under `Round 1/2` or
    `Round 2/2`, so evidence rounds remain distinct from execution attempts.
27. As an operator, I want later attempts labelled `user retry` or `loop`, so I can tell
    manual intervention from graph control flow.

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
- The `applyPaneKey` roster path stays a working fallback with its real API
  (`selectedIndex`, `level:"roster"|"detail"`); the panel does not touch it. The
  8 abandoned-model WIP tests were reconciled to real coverage once the panel
  shipped (see WIP-test reconciliation below); the extension suite is fully green.
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

### Dynamic rows, rounds, and attempts

- `GraphRunReporter` registers each generated node before its first update and assigns a
  monotonic, collision-free index. Registration updates task totals, selector/prompt data,
  dependencies, dependents, and inherited phase metadata.
- Only materialized fanout children appear. Each child inherits its fanout phase index and
  title, so evidence children group under `Round 1/2` or `Round 2/2` rather than a computed
  static stage.
- Evidence rounds are phase metadata, not attempts. The first graph-level start has no
  attempt reason; later starts render `attempt N · user retry` or `attempt N · loop`.
  Internal schema or validation-gate retries remain within one graph attempt.
- Generated rows retain the same model, record, dependency, controls, privacy, and
  live/history inspection behavior as ordinary agent rows.

### Panel state (pane-local)

```
interface PanelState {
  cursor?: Target;                      // stage-header or node selection
  runIndex: number;                     // which run the switcher points at
  scroll: number;                       // roster scroll offset (pages the focused stage's nodes)
  detailScroll: number;                 // detail-zone scroll offset (v2)
  filter: "all" | "running" | "failed"; // v1.5
  collapsedStages: number[];            // v1.5 — manual force-collapse over auto-fit (v3)
  focus: "roster" | "detail";           // which zone owns the cursor (v3)
  detailCursor: number;                 // index into the detail's navigable sections (v3)
  expandedSections: string[];           // expanded section keys, global: "prompt"/"outcome" (v3)
}
```

The manager owns one `PanelState` plus the run list. Default `runIndex` resolves
to the last active run (newest live, else newest overall — the existing
`pickTask` rule). Switching runs resets to the roster overview (`cursor`, `scroll`,
`detailScroll`, `collapsedStages`, `focus`, `detailCursor`, `expandedSections`) while
keeping the filter.

### Keys (panel view)

Two-level focus (`focus: "roster" | "detail"`) mirrors the always-on two-zone body. (v3)

**Roster focus (default):**
- `↑↓` / `j`/`k` — move the cursor over the stage-header/node targets; the detail below
  mirrors the cursor (and its detail cursor re-tops).
- `⏎ enter` — toggle the selected stage header, or drill INTO the detail (`focus:"detail"`)
  for a node with at least one expandable section.
- `space` — toggle collapse of the cursor's stage; the manual override over auto-fit, and it
  lands the cursor on the folded header so a collapsed stage stays re-expandable (the un-trap). (v1.5)
- `esc` / `q` — close the pane.
- `pageUp`/`pageDown` — page the roster (the focused stage's node window).

**Detail focus:**
- `↑↓` / `j`/`k` — move the detail cursor over the navigable sections (Prompt, Outcome), clamped;
  the focused section is auto-followed into view.
- `⏎ enter` / `space` — expand/collapse the focused section (toggles its key in `expandedSections`).
- `esc` / `q` — back out to the roster (does NOT close).
- `pageUp`/`pageDown` — scroll the detail zone.

**Both focuses:**
- `←` / `→` — switch run (resets to the roster overview, keeps the filter).
- `f` — cycle filter all → running → failed (v1.5).
- `c` — open the selected node's conversation (only if it has a `recordId`).
- `e` — expand/collapse complete live graph input near the header; history has no input context.

The panel is **read-only** like the roster: it never wires kill/pause/skip/retry.

### Rendering (top to bottom)

The **header zone** is a run switcher, optional live context, header stats, and summary strip over
a body that fills the rest of the pane, and a one-line footer.

1. **Run switcher** — `‹ <name> ›  <status-dot> <status>  <i>/<n>`; other
   runs appear as `<dot> <name>` health chips when present. Run navigation stays in the footer.
2. **Live context** — optional graph description, the first required input (else first input), and
   `Full inputs · e expand`; expanded JSON shows a bounded header preview plus an explicit omitted-line
   count so the footer remains visible. This is live-only and omitted for historical runs.
3. **Header stats** — reuse `header()`: `<done>/<total> nodes · <elapsed>` plus a terminal
   suffix (`· done`/`· failed`/`· stopped`) when the run has ended.
4. **Summary strip** — colored counts `* running N · ◌ queued N · + done N · ✗ failed N`.

**Body — always two stacked zones (v3):** an auto-fit stage-complete roster on top and an
always-on, capped node/stage detail below, split by a one-line blank divider. Both zones render
at every focus; `enter` no longer gates the detail, it moves the cursor into it. When the pane has
a fixed height, headers win the budget first, the detail asks for up to ~40% (≥ 5 rows when there
is room), and the roster keeps the rest; with no fixed height both zones render in full.

**Auto-fit roster (fixes later-stage clipping)** — every shown stage always emits a header
(`Stage k ── N/M`, rows via `dialogRowGlyph`). When the fully-expanded roster fits the roster
budget, every stage shows its node rows; otherwise only the FOCUSED stage (the resolved cursor's
stage) expands and the others render header-only (`▸`), so no stage header is ever clipped. A
manually collapsed stage (`space`) is always header-only. The `visibleTargets` order and the
renderer share one `isExpanded` decision, so navigation and rendering never disagree.

**Node detail (capped + expandable)** — `Node ── <label>`; `<state> · <agentType> · <model>[ ·
Stage n · elapsed]`; **Waits on (upstream)** (`<glyph> <depId> <state>` per dep, or `entry node`);
**Unblocks (downstream)** (`→ a → b`); **Blast radius** (failed only); **Prompt** (navigable); runtime
facts; **Outcome/Error** (navigable). Prompt and Outcome collapse to their label plus up to two
wrapped lines; when truncated the second line ends with a `dim` `⏎ expand (+N)` affordance.
Entering detail focus and pressing `enter`/`space` expands the focused section (its key in
`expandedSections`, shared across nodes: `"prompt"` / `"outcome"`). Expanded retained output
scrolls with all other detail content and is never fixed-pane tail-clipped. (v3)
- **Stage detail** — aggregates only: a `Stage ── n` header, a summary-strip count line, a
  rolled-up facts line (`Tokens: Σ · Tools: Σ · <wall-clock>`), and a `Failed: …` rollup when
  the stage has failures. It never repeats the per-node rows the roster already shows; `enter`
  or `space` toggles the selected stage header. (v2)

5. **Footer** — `* live`/`+ done` + scroll range (roster range in roster focus, detail range in
   detail focus) + focus-specific control hints (`⏎ detail`/`space fold` vs. `⏎ expand`, `esc
   close` vs. `esc back`).

**Color hierarchy** — `dim` is reserved for **chrome** (separators, rules, the stage-header
count, switcher/footer hints). Everything an operator reads is promoted: model, elapsed,
tokens, runtime facts, the detail status value and the prompt body render `muted` or at the
default foreground, never `dim`. State→glyph/color otherwise reuses the existing vocabulary
(`success`/`error`/`warning`/`accent`); an ASCII tier reuses `ASCII_DIALOG_GLYPHS` gated on
the pane's `ascii` flag. (v2)

### WIP-test reconciliation (resolved)

The 8 red baseline tests targeted an in-pane roster drill-down (`selectedPhase`,
`level:"phases"→"agent"`) that was never implemented and is superseded by the
panel's own navigation. Resolved: while shipping the panel they were left at
baseline (the panel did not touch their API), then reconciled to real coverage —
the manager input-channel tests now assert the panel's `panelState`, and the
`applyPaneKey` tests assert the real roster-fallback API. The extension suite is
now fully green.

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
- Gate every slice on `tsc --noEmit`, `biome check`, and `pnpm test:extensions`
  (the suite is fully green — no failures).

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
- v2 = roster/detail split: `enter` drills the cursor into a two-zone detail (roster above a
  node/stage detail), `esc` backs out before closing, `space` becomes the sole fold key, the
  node outcome is pinned at the bottom, a stage cursor shows aggregates instead of repeating its
  rows, and `dim` is reserved for chrome so model/elapsed/tokens/prompt read clearly.
- v3 = always-on capped detail + auto-fit roster + two-level focus: the detail is always
  visible (no detail mode) with `focus:"roster"|"detail"`; the roster auto-fits so every stage
  header always shows (expand-all-if-it-fits, else focused-stage-only); Prompt and Outcome
  collapse to two lines with a `⏎ expand (+N)` affordance and expand via `expandedSections`;
  `enter` moves the cursor into the detail to pick a section, `esc` backs out; the Outcome stays
  pinned at the bottom. `PanelState.mode` becomes `focus`, plus `detailCursor` and
  `expandedSections`; `collapsedStages` is now the manual override over auto-fit.
