# Herdr Agent-Graph Panel Presentation

Status: shipped

Owner: docs/AGENTS.md (specs bucket)

Related: [Workflow Tool and Notification Presentation](workflow-tool-output-presentation.md) · [Awaited Dynamic Agent-Graph Expansion](dynamic-agent-graph-expansion.md) · [Agent-Graph Bounded Feedback](agent-graph-bounded-feedback.md)

## Problem Statement

The Herdr side panel exposes enough agent-graph data to reconstruct what a workflow is doing, but it does not present that data in the order an operator needs it. Run identity, description, inputs, several progress counters, lifecycle totals, graph rows, node types, model names, dependency facts, prompt text, runtime telemetry, and retained output all compete in one narrow column.

The current roster is flat even when the graph contains meaningful containment. A bounded-feedback coordinator, its iterations, each fanout, generated agent items, evaluators, and downstream synthesis appear as sibling rows. Repeated suffixes such as `iteration 1` carry structure as prose rather than layout. The selected-node detail repeats internal labels and exposes long identity values before the retained result.

The result is technically complete but visually expensive. An operator must translate implementation-shaped rows into answers to four basic questions:

- What workflow is this, and has it completed?
- Which work belongs together?
- Which node is selected, and what did it produce?
- Which information is primary versus diagnostic metadata?

## Solution

Present the graph panel in Pi and in the Herdr pane as a dense, hierarchy-first workflow inspector; the Herdr pane stays read-only:

1. Show one stable run identity, one human description, and one honest composition-only aggregate summary; carry live elapsed on the `∑` status line rather than the aggregate.
2. Render the effective graph as a compact tree. Indentation expresses containment: workflow → coordinator → iteration → fanout/evaluator → generated agent item. Vertical order expresses progression. Dependencies that cannot be represented honestly as containment remain in selected-node detail.
3. Give each graph node one physical roster row. Keep the status symbol, short status text, node label, and trailing role/model metadata on that row.
4. Represent bounded-feedback rounds with a `↻ Iteration N` structural row instead of repeating `· iteration N` on every child.
5. Keep selection in its own gutter. Selection never replaces lifecycle status or corrupts tree rails.
6. Pair status symbol, short text, and semantic theme color. Color reinforces meaning but never carries it alone.
7. Keep functional-node labels at normal contrast because they are selectable graph structure. Dim only secondary metadata, tree chrome, decisions, counts, and model/type annotations.
8. Call the lower zone `Selected node`, because agent and coordination nodes are both selectable. Put retained prompt/outcome before low-value identity metadata.
9. Omit zero-value counters. Separate agents from coordination nodes in the aggregate summary.
10. Preserve width safety, Unicode/ASCII fallback, read-only behavior, filters, folding, run switching, scrolling, contextual key hints, and the existing render fallback.
11. Preserve the same hierarchy, counts, configured workflow description, iteration decisions, and flow after extension or session reload.
12. Resolve historical selected-node prompt and outcome from bounded session artifacts on demand when available; never copy that content or its private location into graph history.
13. On a live run, carry elapsed and lifecycle composition on a `∑` status line above the footer, bracket the elapsed of each running or queued agent row, and fold the settled frontier first when a bounded pane cannot show the whole roster.

### Exact accepted mock

The following mock is a real capture of the completed `context-gather` fixture at 72 columns and is normative. Text may change only when required by the actual run data, current lifecycle, configured keybindings, terminal width, or Unicode/ASCII mode. Hierarchy, ordering, density, labels, disclosure, and emphasis MUST match it.

```text
 context-gather                                                COMPLETED
 Adaptively gather evidence with one gap-closing pass
 8 agents · 3 coordination nodes · 2 iterations

 ▾ Graph run ───────────────────────────────────────────────────────────

     ├─ ✓ done  Research                 bounded feedback · 2 iterations
     │  ├─ ↻ Iteration 1                                        continue
     │  │  ├─ ✓ done  Gather evidence                  fanout · 4 agents
     │  │  │  ├─ ✓ done  item 1                 chengfeng · GPT-5.6 Luna
     │  │  │  ├─ ✓ done  item 2                 chengfeng · GPT-5.6 Luna
   › │  │  │  ├─ ✓ done  item 3                 chengfeng · GPT-5.6 Luna
     │  │  │  └─ ✓ done  item 4                 chengfeng · GPT-5.6 Luna
     │  │  └─ ✓ done  Evaluate evidence           direnjie · GPT-5.6 Sol
     │  └─ ↻ Iteration 2                                      sufficient
     │     ├─ ✓ done  Gather evidence                   fanout · 1 agent
     │     │  └─ ✓ done  item 1                 chengfeng · GPT-5.6 Luna
     │     └─ ✓ done  Evaluate evidence           direnjie · GPT-5.6 Sol
     └─ ✓ done  Synthesize context               jintong · GPT-5.6 Terra


 ─ Selected node ──────────────────────────────────────────────────────

 Gather evidence · iteration 1 · item 3
 Completed · agent · chengfeng · GPT-5.6 Luna · 45s

 Flow
   Gather evidence · iteration 1
      └─ this agent
           └─ Evaluate evidence · iteration 1

 Prompt
   retained prompt retained prompt retained prompt retained prompt
   retained prompt retained prompt retained pr…  Enter expand (+8 lines)

 Outcome
   retained outcome retained outcome retained outcome retained outcome
   retained outcome retained outcome retained …  Enter expand (+8 lines)

 Metadata
   45,423 tokens · 11 tools
   Key: research
   Instance: work-1-2…                                    Space identity
 ∑ ✓ 11 done                                                       2m40s
 ↑↓ select · Enter expand · Space fold · f filter · c convo · Esc close
```

### Live frontier mock

While a run is live in a bounded pane, the panel folds the settled frontier first and reports composition on a `∑` status line above the footer. This capture of the in-flight bounded-feedback fixture at 72×30 is normative:

```text
 context-gather                                                  RUNNING
 Adaptively gather evidence with one gap-closing pass
 9 agents · 3 coordination nodes · 2 iterations

 ▾ Graph run ───────────────────────────────────────────────────────────

     ├─ ● running  Research              bounded feedback · 2 iterations
     │  ├─ ↻ Iteration 1 ▸                             6 done · continue
     │  └─ ↻ Iteration 2
     │     ├─ ● running  Gather evidence               fanout · 2 agents
     │     │  ├─ ✓ done     item 1              chengfeng · GPT-5.6 Luna
   › │     │  └─ ● running  item 2 [21s]        chengfeng · GPT-5.6 Luna
     │     └─ ○ queued   Evaluate evidence [50s]  direnjie · GPT-5.6 Sol
     └─ ○ queued   Synthesize context [3m20s]    jintong · GPT-5.6 Terra


 ─ Selected node ──────────────────────────────────────────────────────

 Gather evidence · iteration 2 · item 2
 Running · agent · chengfeng · GPT-5.6 Luna · 21s

 Flow
   Gather evidence · iteration 2
      └─ this agent




 ∑ ● 3 running · ○ 2 queued · ✓ 7 done                             3m20s
 ↑↓ select · Enter expand · Space fold · f filter · Esc close
```

### Visual semantics

- `COMPLETED` is the run-level lifecycle label. It uses semantic status color without a duplicate glyph.
- Node rows use a fixed status column: `✓ done`, `● running`, `○ queued`, `! blocked`, `× failed`, `– skipped`, `Ⅱ paused`, or `■ stopped`.
- Unicode status symbols use semantic theme roles. ASCII mode uses `+ done`, `* running`, `o queued`, `! blocked`, `x failed`, `- skipped`, `|| paused`, and `# stopped`.
- Replayed/cached work annotates the actual lifecycle (`✓ done · replayed`); replay is not a replacement lifecycle state.
- The `↻` symbol identifies an iteration group, not lifecycle. ASCII mode spells `Iteration N` without a symbolic replacement.
- The selection gutter is independent from tree and status columns. Reverse video is preferred; `›` is the visible fallback. Selecting a row restores full contrast to that row.
- Node labels remain normal foreground. Tree rails, separators, structural counts, iteration decisions, node types, models, and telemetry are subordinate. Settled functional-node identity MUST NOT resemble disabled content.
- At narrow widths preserve, in order: selection, tree position, status text, and node identity. Drop or wrap model, actor, role, and coordination metadata before truncating primary state.
- Running and queued agent rows carry a dim elapsed bracket after the label (`item 2 [21s]`, `Evaluate evidence [50s]`), anchored on `startedAt` for running and `queuedAt` for queued and frozen at `pausedAt` while the run is paused. Coordination rows and settled rows never bracket, and the trailing `waiting` annotation is not repeated. A bracket appears whole or not at all. Under width pressure trailing metadata drops the model before the agent type.
- The `∑` status line sits directly above the footer and counts every entry by lifecycle in the fixed order failed, blocked, stopped, running, paused, queued, done, skipped, omitting zero categories. Each segment keeps its lifecycle color; elapsed is right-aligned and uncolored. Under width pressure it drops the glyphs first, then trailing segments, always keeping elapsed. ASCII mode drops the `∑` glyph and uses the ASCII lifecycle glyphs.

### Structural semantics

- Indentation represents containment, never an arbitrary DAG edge.
- Branch connectors convey containment directly; no rail-only spacer rows appear between roster rows.
- A bounded-feedback node contains iteration groups.
- Each iteration contains its work fanout and evaluator.
- A fanout contains the generated agent items it owns.
- A downstream root node such as synthesis remains a workflow child; it does not become a visual child of an upstream node merely because it depends on that node.
- The selected-node `Flow` section expresses the immediate upstream → selected node → immediate downstream relationship. Multi-parent, cross-group, conditional, and loop dependencies remain explicit there rather than being falsified as tree ownership.
- Iteration decisions such as `continue` and `sufficient` appear once on the iteration row.
- Generated item labels are local to their fanout (`item 1`) because iteration and fanout context are already visible in the tree. Selected-node identity retains the complete binding label.
- Under a bounded live pane the roster auto-folds its settled frontier: only while the run is running or paused, only when the roster overflows its height budget, folding the topmost eligible group first and stopping once the roster fits. The budget always assumes the `Selected node` zone takes its full share, so moving the cursor between node and structural rows never folds or unfolds other groups. A group is eligible only when it has children, every entry beneath it is `done`, the user has not expanded it, and the cursor does not sit inside it. A folded settled iteration summarizes as `N done · decision`.
- Auto-fold is derived per render and never persisted, so roster navigation targets always equal the rendered rows. A user Space toggle wins over auto-fold: expanding an auto-folded group records it in `expandedTargets` and keeps it open; folding records it in `collapsedTargets`. Run switching clears both.

## User Stories

1. As an operator, I want one stable workflow identity, so that repeated headings do not compete for attention.
2. As an operator, I want one aggregate progress line, so that workflow progress is not represented by several unexplained counters.
3. As an operator, I want agent and coordination-node counts distinguished, so that structural nodes are not reported as agents.
4. As an operator, I want zero-value lifecycle categories omitted, so that completed runs do not advertise `running 0`, `queued 0`, and `failed 0`.
5. As an operator, I want the graph rendered as a hierarchy, so that containment is visible without reading repeated suffixes.
6. As an operator, I want indentation to mean containment consistently, so that the tree does not lie about DAG dependencies.
7. As an operator, I want bounded-feedback iterations represented as structural groups, so that gather/evaluate cycles are immediately recognizable.
8. As an operator, I want each iteration decision shown once, so that `continue` and `sufficient` are visible without repetition.
9. As an operator, I want fanout items nested beneath their owner, so that generated work remains connected to its coordination node.
10. As an operator, I want one physical row per node, so that a large graph remains dense and scannable.
11. As an operator, I want status in a stable column, so that mixed lifecycle states compare vertically.
12. As an operator, I want status conveyed through text, symbol, and semantic color, so that it remains understandable in monochrome and ASCII terminals.
13. As an operator, I want selection represented independently from status, so that selecting a node does not erase its lifecycle.
14. As an operator, I want functional-node labels readable at normal contrast, so that selectable graph structure does not look disabled.
15. As an operator, I want secondary role/model metadata visually quieter, so that node identity and state lead each row.
16. As an operator, I want replay represented as provenance, so that cached completion is not mistaken for a distinct lifecycle.
17. As an operator, I want the lower zone labelled `Selected node`, so that coordination-node inspection is described honestly.
18. As an operator, I want selected detail to lead with state and retained content, so that prompt and outcome outrank UUIDs and token telemetry.
19. As an operator, I want an immediate flow representation, so that I can see what the selected node waits for and unblocks.
20. As an operator, I want complex dependencies kept explicit rather than forced into indentation, so that multi-parent and cross-group edges remain truthful.
21. As an operator, I want long prompt and outcome sections collapsed with an exact omitted-line affordance, so that detail remains compact and recoverable.
22. As an operator, I want identity metadata behind disclosure, so that long internal IDs do not dominate the default view.
23. As a narrow-terminal user, I want state and node identity preserved before telemetry, so that width pressure removes the least important information first.
24. As an ASCII-terminal user, I want a complete textual fallback, so that graph hierarchy and lifecycle remain understandable without Unicode.
25. As an operator, I want contextual footer controls, so that only actions valid for the current focus and selection are advertised.
26. As an operator, I want filters, folds, scrolling, run switching, input disclosure, and conversation opening preserved, so that presentation polish does not remove supervision capability.
27. As an operator, I want a completed run to retain the same hierarchy after reload, so that history remains a useful workflow inspector rather than degrading to a flat roster.
28. As an operator, I want retained node artifacts resolved on demand, so that available prompt and outcome detail survives reload without entering graph-history metadata.
29. As a maintainer, I want the graph panel in Pi and in the Herdr pane to share this presentation, so that the two hosts do not diverge.
30. As a maintainer, I want model-visible results, graph execution, notification behavior, and orchestration permissions unchanged, so that durable presentation cannot alter execution.
31. As a maintainer, I want rendering failure to retain the existing safe fallback, so that presentation defects never remove run visibility.
32. As a maintainer, I want the exact accepted mock covered through the highest public render seam and a real Herdr capture before and after reload, so that tests and runtime evidence prove the same presentation.

## Implementation Decisions

- The existing pure observability renderer and key handler remain the single presentation seam for the graph panel in Pi and in the Herdr pane. The pane manager continues to own run selection, panel state, and the safe fallback renderer.
- Build a presentation tree from authoritative graph metadata retained by the live run projection or sanitized graph-history projection. The tree model separates workflow nodes, bounded-feedback iterations, fanout ownership, generated items, and ordinary dependencies. It does not parse display labels to infer structure.
- Iteration rows are presentation-only structural groups derived from durable feedback iteration/ownership metadata. They are navigational grouping rows, not executable nodes and not included in the node denominator.
- Node rows retain stable node identity for selection and detail even when their displayed labels become local to a structural group.
- Role classification is explicit: executable agent nodes count as agents; bounded feedback and fanout owners count as coordination nodes. Iteration groups do not count as either.
- The roster renderer owns four aligned columns: selection gutter, tree prefix, fixed lifecycle field, and flexible node content. Trailing metadata is width-budgeted independently.
- Status vocabulary reuses semantic theme roles and existing Unicode/ASCII capabilities. Text labels remain present alongside symbols.
- Selection uses the existing reverse-video vocabulary where available. Tree rails and lifecycle symbols remain visible inside the selected row.
- Selected detail uses the same authoritative upstream/downstream relationships as the current panel. It presents them as a compact flow when linear and as explicit upstream/downstream groups when the relationship is not linear.
- The existing read-only interaction model remains intact. Footer hints are derived from current focus, selection kind, expandable sections, and configured keybindings rather than hard-coded globally.
- The graph panel in Pi and in the Herdr pane shares this presentation. Shared low-level glyph and width helpers may remain shared, but this specification does not redesign transcript tool rows or notifications.
- Rendering remains width-safe by terminal cells after ANSI styling. No tree prefix, selection marker, status field, metadata suffix, or wrapped detail line may exceed the supplied width.
- Graph history version 2 persists only sanitized presentation metadata: configured workflow description, node kind/name/role, history-local parent and dependency indices, iteration/item position, conditional/loop connections, and iteration decision enums. Capture translates transient bindings and instance IDs to local indices, then discards those runtime identities.
- Version 1 history remains readable with its explicit flat fallback. Unknown future versions remain untouched with writes disabled. Version 2 decoding strictly allowlists fields and rejects invalid references, self-parenting, containment cycles, and out-of-bounds topology.
- Graph-owned transcript artifacts use deterministic run-ID plus history-index aliases. Historical detail resolves them only while they remain in the current session artifact area; graph history stores neither content, paths, runtime IDs, conversation handles, nor artifact availability promises.
- Presentation work MUST NOT change graph execution, model-visible tool content, notification delivery, orchestration permissions, or execution-recovery snapshots.
- A single height-budget helper derives the roster floor, header rows, detail cap, and roster cap; `planPanel` reads its roster cap to decide frontier auto-fold and `renderPanelLines` reads it to lay out, so folding and layout agree. From three rows up, the bottom two physical rows are reserved for the `∑` line and footer; a two-row pane keeps one content row and the footer, a one-row pane keeps only the footer, and a zero-row pane renders nothing.
- Panel state gains an optional user-owned `expandedTargets`. Effective folds are `collapsedTargets` plus the per-render auto-fold set, which never includes a group in `expandedTargets`. The pane manager and run switching reset both `collapsedTargets` and `expandedTargets`.

## Testing Decisions

- The highest automated seam is the public pure panel renderer and key handler for the graph panel in Pi and in the Herdr pane, supplied with representative live and reloaded `PanelRun` data. Tests assert the rendered hierarchy and state transitions rather than private helper calls.
- Red tests precede production edits and prove: one-row nodes, accurate agent/coordination counts, omission of zero categories, bounded-feedback iteration groups, fanout item containment, evaluator placement, selection-gutter independence, compact selected-node flow, and `Selected node` detail labelling.
- Fixtures use typed graph metadata, never node-label parsing, to distinguish coordination, iteration, fanout ownership, generated items, and ordinary dependencies.
- Status tests cover queued, running, completed, failed, blocked, skipped, paused, stopped, and replayed annotation with Unicode, ASCII, colorless, selected, and settled-functional-node variants.
- Width tests cover `0`, `1`, `2`, `8`, `20`, `40`, `80`, and `120` columns with ANSI, CJK, emoji, combining characters, long model names, long node names, and long IDs. Every physical line fits its visible-cell width.
- Navigation tests cover roster/detail focus, selection across structural grouping rows, filtering, folding, run switching, prompt/outcome expansion, input expansion, conversation opening, paging, and escape/back behavior.
- Compatibility tests prove rendering failure still uses the safe fallback, and model-visible results/execution behavior are unaffected.
- Persistence tests round-trip a representative run through `snapshotHistory → JSON → decodeHistory → mergeWorkflowRuns → toPaneSource → renderPanelLines`; the post-reload hierarchy, counts, decisions, and flow MUST match the live projection.
- Privacy tests inspect the serialized history and prove it contains no bindings, UUIDs, conversation handles, artifact paths, prompts, outputs, errors, scripts, or inputs. Artifact tests prove lookup is bounded, alias-keyed, optional, and unavailable outside the exact session.
- Legacy tests keep version 1 history readable and flat; malformed version 2 topology fails closed; unknown versions remain byte-preserved and non-writable.
- Runtime verification uses a fresh Pi session launched through `interactive_shell` to execute the saved `context-gather` graph. Execution evidence proves real fanout, bounded-feedback evaluation and decisions, and synthesis; multi-iteration fixtures cover the continuation shape deterministically.
- Presentation verification uses Herdr itself, following `herdr --skill`, because the interactive-shell terminal does not display the Herdr side pane. Live and post-reload captures MUST each be compared line-by-line and hierarchy-by-hierarchy against the exact accepted mock at a representative wide size and once at a narrow width.
- Real verification checks semantic colors, Unicode/ASCII fallback where configurable, reverse-video selection, node-row density, iteration grouping, selected-node detail ordering, width safety, contextual footer hints, and cleanup of every temporary Pi/Herdr process.
- `herdr-panel-live-frontier.test.ts` covers the live-run presentation through the same public seam: the `∑` composition line with its authoritative order, zero-omission, width degradation, and ASCII fallback; per-node elapsed brackets and paused lifecycle; frontier auto-fold guards; user-toggle-wins over auto-fold; and the normative live-frontier mock at 72×30 and 44×30.

## Out of Scope

- Changing graph execution, scheduling, retry, loop, fanout, bounded-feedback, execution-recovery persistence, cancellation, or outcome semantics.
- Redesigning tool-call rows, completion notifications, FleetView, or agent conversations.
- Drawing arbitrary DAG edges as a full node-link canvas. The roster uses truthful containment plus explicit selected-node dependencies.
- Adding mutation controls to the read-only Herdr pane.
- Copying prompts, outputs, errors, conversations, artifact paths, or runtime identifiers into graph-history metadata.
- Replacing Pi or Herdr theme systems, keybinding systems, terminal width helpers, or Unicode capability detection.

## Further Notes

This specification supersedes the stale flat, stage-oriented `Graph Run Monitor — Observability Panel` draft. The shipped workflow tool/notification specification remains authoritative for transcript tool rows and notifications; this document owns the graph panel in Pi and in the Herdr pane.
