# Saved Agent Graph YAML, Manual Invocation, and Decision Gates

Status: draft

## Problem Statement

Saved agent graphs currently resolve only JSON, manual prompts have no explicit saved-agent-graph token beside `$skill:<name>`, and `human_gate` offers an approve/reject decision only through the existing UI. Authors need a readable persisted format, users need deliberate invocation by name, and graph authors need a small choice between human and Subagent decisions without weakening the existing approval boundary or inventing another executor.

## Solution

1. Accept `.graph.yaml` alongside `.graph.json` for saved agent graphs. Parse at the saved-agent-graph resolver boundary into the same `AgentGraph` validation and runtime; keep existing JSON behavior and root precedence. Reject a name that resolves to both formats within one root as ambiguous.
2. Recognize `$graph:<name>` as a visible, explicit opt-in to run exactly the named saved agent graph. Autocomplete uses the same resolution and precedence rules as execution. The current orchestrator maps the full user request to graph input, asks the user when required input cannot be inferred, and calls the existing `agent_graph` tool.
3. Provide exactly three decision-gate node types: `human_gate`, `agent_gate`, and `hybrid_gate`. Each exposes exactly `{ approved: boolean }` to downstream ValueRefs and conditions, which read `$.approved`. `human_gate` keeps the existing UI and approval boundary; `agent_gate` requires a configured Subagent decision; `hybrid_gate` asks that Subagent first and escalates only a valid, explicit `undecided` result to the human UI.

## User Stories

1. As a graph author, I want a saved agent graph in `.graph.yaml` to resolve by name, so I can author persisted graph data in YAML.
2. As a graph author, I want existing `.graph.json` files to keep resolving unchanged, so adopting YAML is optional.
3. As a graph author, I want both formats to reach the same graph validation and runtime, so format choice cannot bypass execution checks.
4. As a graph author, I want a JSON and YAML file with the same name in one root rejected as ambiguous, so format choice is never silent.
5. As an operator, I want existing root precedence retained, so adding YAML does not reorder where saved agent graphs come from.
6. As a graph author, I want duplicate YAML keys and unsafe or excessive aliases rejected, so parsing cannot hide overrides or consume unbounded resources.
7. As a user, I want `$graph:<name>` beside `$skill:<name>`, so I can explicitly request a saved agent graph from my prompt.
8. As a user, I want autocomplete to list resolvable saved agent graphs under runtime precedence, so a suggested name is one the resolver can use.
9. As a user, I want the token to remain visible, so the invocation intent is inspectable in my request.
10. As a user, I want exactly the named saved agent graph authorized by my token, so unrelated agent graph runs are not implicitly permitted.
11. As a user, I want the orchestrator to use my full request as graph input and ask me when required input is unclear, so it does not silently invent missing values.
12. As a user, I want multiple distinct graph tokens rejected, so a single prompt cannot silently select between agent graphs.
13. As a user, I want missing, ambiguous, or disabled saved agent graphs reported clearly, so I know why an invocation cannot proceed.
14. As a graph author, I want declared nested subgraphs to pass existing preflight under the named graph's authorization, so composition works without authorizing arbitrary other runs.
15. As a graph author, I want `human_gate` to keep its current approve/reject UI, so human-only decisions retain the existing approval boundary.
16. As a graph author, I want `agent_gate` to use a configured Subagent with no human fallback, so an unavailable or invalid automated decision fails rather than becoming an approval request.
17. As a graph author, I want `hybrid_gate` to seek the configured Subagent's decision first and prompt a human only for an explicit `undecided` with a nonempty reason, so uncertainty has one deliberate escalation path.
18. As an operator, I want agent inability, invalid structured output, unavailable agents, and execution failures to fail closed, so infrastructure failures never appear to be uncertainty or human approval.
19. As a downstream node author, I want all three gates to expose `{ approved: boolean }`, so ValueRefs and conditions can read `$.approved` regardless of who decided.
20. As an operator, I want human decisions distinguishable in monitor and provenance, so I can tell when a person, rather than a Subagent, supplied the value.
21. As an operator, I want cancellation and resume of a waiting gate to preserve the decision boundary, so a restored agent graph run cannot silently skip a required human choice.

## Implementation Decisions

- The saved-agent-graph resolver alone parses persisted YAML, using a direct YAML dependency and JSON-compatible values. It rejects duplicate keys and unsafe or excessive aliases before passing data through the existing `AgentGraph` validation and runtime. JSON remains backward compatible; root precedence remains unchanged. Same-name JSON and YAML within one root fail as ambiguous rather than selecting a preferred format. The repository-owned portfolio may migrate after parser support exists.
- `$graph:<name>` is manual opt-in for one exactly named saved agent graph; it is not an inline graph format. Autocomplete and runtime use the same resolvable names and precedence. The token remains visible. Multiple distinct graph tokens fail before launch. Missing, ambiguous, and disabled resolutions produce clear errors.
- The token permits the selected agent graph and its declared nested subgraphs through existing delegation preflight, not arbitrary other agent graph runs. The current orchestrator, not token handling, maps the full request to input, asks about required input it cannot infer, and calls `agent_graph`. The graph tool retains validation and delegation preflight before launch. Token handling does not execute an agent graph directly or make the parent orchestrator callable from a background run.
- `human_gate` is human-only and retains the current approve/reject UI and approval boundary. The v1 decision value exposed by all three gates is exactly `{ approved: boolean }`; downstream conditions use `$.approved`. Gate `outputSchema` validation applies to that value, not to the internal agent result. `agent_gate` and `hybrid_gate` each name a configured Subagent. Their decision attempt returns only `decided` carrying `{ approved: boolean }`, or `undecided` carrying a nonempty reason. The runtime unwraps a `decided` result and validates its decision value before exposing it downstream.
- `agent_gate` treats `undecided` as node failure and never falls back to a human. `hybrid_gate` uses the existing human UI only after a valid, explicitly typed `undecided` with a nonempty reason; the human approve/reject choice produces the same validated `{ approved: boolean }` value. Agent inability, invalid structured output, unavailable agent, and execution failure fail the node for either agent-backed gate, without escalation. Monitor and provenance distinguish a human decision from a Subagent decision.
- `validation.gate` remains deterministic node validation; it is not a decision-gate node type.

## Testing Decisions

Test externally visible contracts at the highest existing seams rather than actor internals:

1. **Saved resolver:** accept JSON and YAML equivalents through the same validation path; retain JSON compatibility and root precedence; reject same-name cross-format files in one root, duplicate keys, unsafe or excessive aliases, and values outside the accepted JSON-compatible data shape. Validate the repository-owned portfolio after any YAML migration.
2. **Inline token extension:** assert token detection and autocomplete over resolvable saved agent graphs under runtime precedence; token visibility and explicit opt-in; authorization of exactly the selected saved agent graph and its declared nested subgraphs, not unrelated runs; original prompt preservation and injected graph request context; rejection of multiple distinct tokens; clear missing, ambiguous, and disabled errors; and no direct agent graph execution by token handling.
3. **Graph validation and tool end to end:** accept the three gate node contracts and reject malformed configurations or decision shapes; assert each exposes exactly `{ approved: boolean }` to downstream ValueRefs/conditions at `$.approved`, with `outputSchema` validating this exposed value rather than the internal agent result. Keep validation and delegation preflight ahead of launch, including declared nested subgraphs without authorization of unrelated runs.
4. **Human-gate and lifecycle seams:** assert human-only approval remains approve/reject; `agent_gate` fails on `undecided` with no human fallback; `hybrid_gate` prompts only for valid typed `undecided` with a nonempty reason; inability, invalid output, unavailable agents, and execution failures fail closed; human provenance remains distinct; and cancellation/resume never silently supplies a decision or duplicates a prompt.
5. **Fresh-Pi real-runtime QA:** submit `$graph:<name>` prompts against saved agent graphs with complete and incomplete required inputs. Inspect whether the orchestrator calls the existing `agent_graph` tool with valid input mapped from the full request, or asks the user for missing input before launch.

## Out of Scope

- YAML inline tool input, `.yml` files, or a mandatory portfolio migration.
- Graph catalog or validate-only commands, richer invocation syntax, direct token execution, or a second executor.
- Typed human forms beyond approve/reject, a redesigned monitor, or making the parent orchestrator callable from background execution.
- Treating deterministic `validation.gate` as a decision gate.

## Further Notes

This is a draft contract, not a description of shipped support. The repository-owned portfolio can remain JSON until YAML parsing and its validation coverage are in place.
