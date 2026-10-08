# Saved Agent Graph YAML and Manual Invocation

Status: shipped

## Problem Statement

Authors need a readable persisted format, and users need deliberate invocation by name without inventing another executor.

## Solution

1. Accept `.graph.yaml` alongside `.graph.json` for saved agent graphs. Parse at the saved-agent-graph resolver boundary into the same `AgentGraph` validation and runtime; keep existing JSON behavior and root precedence. Reject a name that resolves to both formats within one root as ambiguous.
2. Recognize `$graph:<name>` as a visible, explicit opt-in to run exactly the named saved agent graph. Autocomplete uses the same resolution and precedence rules as execution. The current orchestrator maps the full user request to graph input, asks the user when required input cannot be inferred, and calls the existing `agent_graph` tool.

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

## Implementation Decisions

- The saved-agent-graph resolver alone parses persisted YAML, using a direct YAML dependency and JSON-compatible values. It rejects duplicate keys and unsafe or excessive aliases before passing data through the existing `AgentGraph` validation and runtime. JSON and YAML share root precedence. Same-name JSON and YAML within one root fail as ambiguous rather than selecting a preferred format.
- `$graph:<name>` is manual opt-in for one exactly named saved agent graph; it is not an inline graph format. Autocomplete and runtime use the same resolvable names and precedence. The token remains visible. Multiple distinct graph tokens fail before launch. Missing, ambiguous, and disabled resolutions produce clear errors.
- The token permits the selected agent graph and its declared nested subgraphs through existing delegation preflight, not arbitrary other agent graph runs. The current orchestrator, not token handling, maps the full request to input, asks about required input it cannot infer, and calls `agent_graph`. The graph tool retains validation and delegation preflight before launch. Token handling does not execute an agent graph directly or make the parent orchestrator callable from a background run.

## Testing Decisions

Test externally visible contracts at the highest existing seams rather than actor internals. Tests live in [`extensions/subagents/test/`](../../extensions/subagents/test/). The seams are:

1. **Saved resolver:** accept JSON and YAML equivalents through the same validation path; retain JSON compatibility and root precedence; reject same-name cross-format files in one root, duplicate keys, unsafe or excessive aliases, and values outside the accepted JSON-compatible data shape. Validate the repository-owned portfolio after any YAML migration.
2. **Inline token extension:** assert token detection and autocomplete over resolvable saved agent graphs under runtime precedence; token visibility and explicit opt-in; authorization of exactly the selected saved agent graph and its declared nested subgraphs, not unrelated runs; original prompt preservation and injected graph request context; rejection of multiple distinct tokens; clear missing, ambiguous, and disabled errors; and no direct agent graph execution by token handling.
3. **Graph tool end to end:** keep validation and delegation preflight ahead of launch, including declared nested subgraphs without authorization of unrelated runs.
4. **Fresh-Pi real-runtime QA:** submit `$graph:<name>` prompts against saved agent graphs with complete and incomplete required inputs. Inspect whether the orchestrator calls the existing `agent_graph` tool with valid input mapped from the full request, or asks the user for missing input before launch.

## Out of Scope

- YAML inline tool input, `.yml` files, or a mandatory portfolio migration.
- Graph catalog or validate-only commands, richer invocation syntax, direct token execution, or a second executor.
- Making the parent orchestrator callable from background execution.
- Decision gates; [ADR 0005](../adr/0005-decision-gate-classifier-first-with-orchestrator-escalation.md) and the [subagents maintenance contracts](../../extensions/subagents/MAINTENANCE.md#decision-gates-and-escalation) own them.

## Further Notes

The repository-owned portfolio may remain JSON because JSON and YAML saved graphs share the same validation and runtime path.
