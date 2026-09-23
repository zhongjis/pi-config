import type { HistoricalNodeDetail } from "../graph/history-artifact.js";
/** Pure, read-only Herdr graph inspector. The centered workflow dialog is separate. */

import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { HISTORY_ARTIFACT_DETAIL, historyDisclosure } from "../graph/history-view.js";
import {
  collapse,
  displayState,
  formatDuration,
  type WorkflowAgentEntry,
  type WorkflowDisplayState,
  type WorkflowRunStatus,
} from "../graph/progress.js";
import {
  clampLine,
  highlightRow,
  type WorkflowCardColor,
  type WorkflowCardLine,
  type WorkflowCardSegment,
} from "./workflow-card.js";
import {
  subStatusAnnotations,
  type WorkflowDialogSource,
} from "./workflow-dialog.js";

export type Target =
  | { kind: "stage"; stage: number }
  | { kind: "node"; id: string | number }
  | { kind: "iteration"; owner: string | number; iteration: number };

export interface PanelState {
  /** The selected workflow, iteration or node target; resolves to the first target when unset or stale. */
  cursor?: Target;
  /** Which run the switcher points at (index into the run list). */
  runIndex: number;
  /** Roster scroll offset, in physical lines. */
  scroll: number;
  /** The detail zone's own scroll offset. */
  detailScroll: number;
  /** Roster filter: show all nodes, only running, or only failed. (v1.5) */
  filter: "all" | "running" | "failed";
  /** Compatibility with existing panel state: stage 0 is the workflow root. */
  collapsedStages: number[];
  collapsedTargets?: Target[];
  /** Which zone owns the cursor: the roster overview (default) or the drilled-in detail. (v3) */
  focus: "roster" | "detail";
  /** Index into the detail's navigable (expandable) sections. (v3) */
  detailCursor: number;
  /** Section keys currently expanded, global across nodes: `"prompt"` / `"outcome"`. (v3) */
  expandedSections: string[];
}

export function initialPanelState(): PanelState {
  return {
    runIndex: 0,
    scroll: 0,
    detailScroll: 0,
    filter: "all",
    collapsedStages: [],
    focus: "roster",
    detailCursor: 0,
    expandedSections: [],
  };
}

/** One switchable run, built by the manager from a background task. */
export interface PanelRun {
  id: string;
  name: string;
  status: WorkflowRunStatus;
  source: WorkflowDialogSource;
  readHistoricalDetail?: (index: number) => HistoricalNodeDetail | undefined;
}

export interface PanelOptions {
  width: number;
  rows?: number;
  ascii?: boolean;
  now?: number;
}

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(Math.max(lo, Math.trunc(value)), Math.max(lo, hi));

const isActive = (status: WorkflowRunStatus): boolean => status === "running" || status === "paused";

/* ------------------------------------------------------------------------- *
 * Lifecycle vocabulary
 * ------------------------------------------------------------------------- */

function stateColor(state: WorkflowDisplayState): WorkflowCardColor {
  switch (state) {
    case "done": return "success";
    case "failed": return "error";
    case "blocked": return "warning";
    case "running": return "accent";
    default: return "dim";
  }
}

function statusWord(state: WorkflowDisplayState): string {
  switch (state) {
    case "done": return "done";
    case "failed": return "failed";
    case "skipped": return "skipped";
    case "blocked": return "blocked";
    case "queued": return "queued";
    case "interrupted": return "stopped";
    case "running": return "running";
  }
}

function runStateColor(status: WorkflowRunStatus): WorkflowCardColor {
  switch (status) {
    case "running": return "accent";
    case "completed": return "success";
    case "failed": return "error";
    case "paused": return "warning";
    case "killed": return "warning";
  }
}


interface TreeNode {
  target: Target;
  label: string;
  entry?: WorkflowAgentEntry;
  decision?: string;
  children: TreeNode[];
}
interface TreeRow { node: TreeNode; rails: string; last: boolean; parent?: Target }
const bindingId = (entry: WorkflowAgentEntry): string => entry.nodeBinding ?? entry.label;
const nodeId = (entry: WorkflowAgentEntry, agents?: readonly WorkflowAgentEntry[]): string | number => {
  if (entry.historyIndex !== undefined) return entry.historyIndex;
  const binding = bindingId(entry);
  return !entry.nodeBinding && agents?.some(other => other !== entry && bindingId(other) === binding) ? `\u0000${entry.index}` : binding;
};
const parentReference = (entry: WorkflowAgentEntry): string | number | undefined => entry.presentation?.parentIndex ?? entry.presentation?.parentInstanceId;
const upstreamIds = (entry: WorkflowAgentEntry): readonly (string | number)[] => entry.depIndices ?? entry.deps ?? [];
const downstreamIds = (entry: WorkflowAgentEntry): readonly (string | number)[] => entry.dependentIndices ?? entry.dependents ?? [];
function sameTarget(a: Target, b: Target): boolean {
  if (a.kind === "stage" && b.kind === "stage") return a.stage === b.stage;
  if (a.kind === "iteration" && b.kind === "iteration") return a.owner === b.owner && a.iteration === b.iteration;
  return a.kind === "node" && b.kind === "node" && a.id === b.id;
}
function targetIndex(targets: readonly Target[], cursor: Target | undefined): number {
  return cursor ? targets.findIndex(target => sameTarget(target, cursor)) : -1;
}
/** Only authoritative containment is admitted. Unknown/legacy rows remain workflow children. */
function presentationTree(agents: readonly WorkflowAgentEntry[]): TreeNode {
  const root: TreeNode = { target: { kind: "stage", stage: 0 }, label: "Workflow", children: [] };
  const nodes: TreeNode[] = agents.map(entry => ({ target: { kind: "node" as const, id: nodeId(entry, agents) }, label: entry.presentation?.name ?? entry.label, entry, children: [] }));
  const byInstance = new Map<string | number, TreeNode>(nodes.flatMap(node => {
    const id = node.entry?.historyIndex ?? node.entry?.instanceId;
    return id === undefined ? [] : [[id, node] as const];
  }));
  const iterations = new Map<TreeNode, Map<number, TreeNode>>();
  const iteration = (owner: TreeNode, n: number, decision?: string): TreeNode => {
    let groups = iterations.get(owner);
    if (!groups) { groups = new Map(); iterations.set(owner, groups); }
    let group = groups.get(n);
    if (!group) {
      group = { target: { kind: "iteration", owner: owner.target.kind === "node" ? owner.target.id : bindingId(owner.entry!), iteration: n }, label: `Iteration ${n}`, decision, children: [] };
      groups.set(n, group); owner.children.push(group);
    }
    return group;
  };
  for (const node of nodes) if (node.entry?.presentation?.kind === "bounded_feedback") {
    for (const round of node.entry.presentation.iterations ?? []) iteration(node, round.iteration, round.decision);
  }
  for (const node of nodes) {
    const meta = node.entry?.presentation;
    const ref = node.entry ? parentReference(node.entry) : undefined;
    const parent = ref === undefined ? undefined : byInstance.get(ref);
    if (parent !== node && parent?.entry?.presentation?.kind === "fanout" && meta?.kind === "agent" && meta.itemIndex !== undefined) {
      node.label = `item ${meta.itemIndex + 1}`;
      parent.children.push(node);
    } else if (parent !== node && parent?.entry?.presentation?.kind === "bounded_feedback" && meta?.iteration !== undefined && (meta.kind === "fanout" || meta.kind === "agent")) {
      iteration(parent, meta.iteration).children.push(node);
    } else root.children.push(node);
  }
  for (const owner of iterations.keys()) owner.children.sort((a, b) => a.target.kind === "iteration" && b.target.kind === "iteration" ? a.target.iteration - b.target.iteration : 0);
  return root;
}
function visibleTree(root: TreeNode, state: PanelState, active: boolean, ascii: boolean): TreeRow[] {
  const matches = (node: TreeNode): boolean => state.filter === "all" || (node.entry && displayState(node.entry, active) === state.filter) || node.children.some(matches);
  const rows: TreeRow[] = [];
  const visit = (node: TreeNode, rails: string, last: boolean, parent?: Target): void => {
    rows.push({ node, rails, last, parent });
    if ((state.collapsedTargets ?? []).some(target => sameTarget(target, node.target)) || node.target.kind === "stage" && state.collapsedStages.includes(0)) return;
    const children = node.children.filter(matches);
    children.forEach((child, i) => { visit(child, parent ? rails + (last ? "   " : ascii ? "|  " : "│  ") : "", i === children.length - 1, node.target); });
  };
  visit(root, "", true);
  return rows;
}
function lifecycle(entry: WorkflowAgentEntry, run: PanelRun, ascii: boolean): { word: string; glyph: string; color: WorkflowCardColor } {
  const state = displayState(entry, isActive(run.status));
  if (run.status === "paused" && state === "running") return { word: "paused", glyph: ascii ? "||" : "Ⅱ", color: "warning" };
  const glyphs: Record<WorkflowDisplayState, string> = ascii
    ? { done: "+", running: "*", queued: "o", blocked: "!", failed: "x", skipped: "-", interrupted: "#" }
    : { done: "✓", running: "●", queued: "○", blocked: "!", failed: "×", skipped: "–", interrupted: "■" };
  return { word: statusWord(state), glyph: glyphs[state], color: stateColor(state) };
}
function aggregate(agents: readonly WorkflowAgentEntry[], root: TreeNode, run: PanelRun, now: number): string {
  const known = agents.filter(entry => entry.presentation);
  const counts: string[] = [];
  const count = (n: number, singular: string, plural = `${singular}s`) => { if (n) counts.push(`${n} ${n === 1 ? singular : plural}`); };
  count(known.filter(entry => entry.presentation?.kind === "agent").length, "agent");
  count(known.filter(entry => entry.presentation?.kind !== "agent").length, "coordination node");
  count(agents.length - known.length, "unclassified node");
  const rounds = (node: TreeNode): number => (node.target.kind === "iteration" ? 1 : 0) + node.children.reduce((sum, child) => sum + rounds(child), 0);
  count(rounds(root), "iteration");
  const task = run.source.task;
  if (task.startTime !== undefined) counts.push(formatDuration(Math.max(0, (task.endTime ?? task.pausedAt ?? now) - task.startTime - (task.totalPausedMs ?? 0))));
  return counts.join(" · ");
}
function withTrailing(line: WorkflowCardLine, metadata: string, width: number): WorkflowCardLine {
  const used = line.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
  if (metadata && used + visibleWidth(metadata) + 2 <= width) line.push({ text: " ".repeat(width - used - visibleWidth(metadata)) + metadata, color: "dim" });
  return clampLine(line, width);
}
function rosterLines(plan: PanelPlan, state: PanelState): { lines: WorkflowCardLine[]; selectedRow?: number } {
  const { width, ascii, visible, resolvedCursor, run } = plan;
  const lines: WorkflowCardLine[] = [];
  let selectedRow: number | undefined;
  const statusWidth = Math.max(0, ...visible.flatMap(row => row.node.entry ? [visibleWidth(`${lifecycle(row.node.entry, run, ascii).glyph} ${lifecycle(row.node.entry, run, ascii).word}`)] : [])) + 2;
  for (const [index, row] of visible.entries()) {
    const { node, rails, last } = row;
    const selected = resolvedCursor && sameTarget(node.target, resolvedCursor);
    const folded = (state.collapsedTargets ?? []).some(target => sameTarget(target, node.target)) || node.target.kind === "stage" && state.collapsedStages.includes(0);
    let line: WorkflowCardLine;
    if (node.target.kind === "stage") {
      const title = ` ${ascii ? folded ? ">" : "v" : folded ? "▸" : "▾"} Workflow `;
      const count = `${plan.agents.filter(entry => entry.state === "done").length}/${plan.agents.length} nodes`;
      line = clampLine([{ text: title }, { text: (ascii ? "-" : "─").repeat(Math.max(1, width - visibleWidth(title) - count.length - 1)) + " " + count, color: "dim" }], width);
    } else {
      const compact = width < 40;
      const gutter = selected ? ascii ? "> " : "› " : "  ";
      const tree = compact ? rails.replaceAll("  ", "") : rails;
      const branch = ascii ? last ? "`" : "+" : last ? "└" : "├";
      const prefix = [{ text: (compact ? "" : "   ") + gutter }, { text: tree + branch + (compact ? " " : ascii ? "- " : "─ "), color: "dim" as const }];
      if (node.entry) {
        const status = lifecycle(node.entry, run, ascii);
        const field = `${status.glyph} ${status.word}`;
        const metadata = node.entry.presentation;
        let trailing = metadata?.kind === "bounded_feedback" ? `bounded feedback${node.children.length ? ` · ${node.children.length} iteration${node.children.length === 1 ? "" : "s"}` : ""}`
          : metadata?.kind === "fanout" ? `fanout${node.children.length ? ` · ${node.children.length} agent${node.children.length === 1 ? "" : "s"}` : ""}`
          : [node.entry.agentType, node.entry.model ?? node.entry.modelId].filter(Boolean).join(" · ");
        const annotations = subStatusAnnotations(node.entry, displayState(node.entry, plan.active), plan.now).filter(value => value !== "replayed" && value !== "cached" && value !== "from resume journal");
        if (annotations.length) trailing += `${trailing ? " · " : ""}${annotations.join(" · ")}`;
        line = withTrailing([...prefix, { text: field, color: status.color }, { text: " ".repeat(compact ? 1 : Math.max(2, statusWidth - visibleWidth(field))) + node.label }, ...(node.entry.cached ? [{ text: " · replayed", color: "dim" as const }] : []), ...(folded ? [{ text: ascii ? " [+]" : " ▸", color: "dim" as const }] : [])], trailing, width);
      } else line = withTrailing([...prefix, { text: `${ascii ? "" : "↻ "}${node.label}` }, ...(folded ? [{ text: ascii ? " [+]" : " ▸", color: "dim" as const }] : [])], node.decision ?? "", width);
    }
    if (resolvedCursor && sameTarget(node.target, resolvedCursor)) selectedRow = lines.length;
    lines.push(selected && state.focus === "roster" ? highlightRow(line, width) : line);
    if (node.target.kind === "stage" && visible[index + 1]) lines.push([]);
  }
  return { lines, selectedRow };
}
function safeInputJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return "[unserializable input]";
  }
}

function formatInputValue(input: unknown): string {
  return typeof input === "string" ? input : safeInputJson(input);
}

function graphContextLines(
  source: WorkflowDialogSource, width: number, expandedSections: readonly string[], maxRows?: number,
 ): WorkflowCardLine[] {
  const lines: WorkflowCardLine[] = [];
  const description = source.meta?.description?.trim();
  if (description) {
    lines.push(...wrapTextWithAnsi(` ${description}`, Math.max(1, width)).map(text => clampLine([{ text }], width)));
  }
  if (source.history || source.input === undefined || !expandedSections.includes("full-inputs")) return lines;
  const input = source.input;
  const expanded = expandedSections.includes("full-inputs");

  // Ordered key/value pairs. Objects surface every key when expanded, the primary
  // key only when collapsed; non-object input is a single "Input" pair.
  const pairs: Array<{ label: string; value: string }> = [];
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const values = input as Record<string, unknown>;
    const schema = source.meta?.inputSchema;
    const required = schema && typeof schema === "object" && Array.isArray((schema as { required?: unknown }).required)
      ? (schema as { required: unknown[] }).required.filter((name): name is string => typeof name === "string")
      : [];
    const keys = Object.keys(values);
    const primary = required.find(name => Object.hasOwn(values, name)) ?? keys[0];
    const ordered = primary === undefined
      ? []
      : expanded ? [primary, ...keys.filter(name => name !== primary)] : [primary];
    for (const key of ordered) pairs.push({ label: key, value: formatInputValue(values[key]) });
  } else {
    pairs.push({ label: "Input", value: formatInputValue(input) });
  }

  // Collapsed clamps the primary pair to one line; expanded wraps every pair in
  // place so the full inputs read as prose, not JSON.
  const valueLines: WorkflowCardLine[] = [];
  for (const { label, value } of pairs) {
    const text = ` ${label}: ${value}`;
    if (expanded) {
      valueLines.push(...wrapTextWithAnsi(text, Math.max(1, width)).map(t => clampLine([{ text: t, color: "dim" }], width)));
    } else {
      valueLines.push(clampLine([{ text, color: "dim" }], width));
    }
  }

  const affordance = clampLine(
    [{ text: ` Full inputs · e ${expanded ? "collapse" : "expand"}`, color: "dim" }], width);

  // The header zone does not scroll, so bound the expanded value to the budget left
  // after the description and affordance. Only a genuine overflow drops a hint.
  if (expanded && maxRows != null) {
    const budget = Math.max(0, maxRows - lines.length - 1);
    if (valueLines.length > budget) {
      const shown = Math.max(0, budget - 1);
      const hidden = valueLines.length - shown;
      lines.push(...valueLines.slice(0, shown));
      lines.push(clampLine([{ text: `  …${hidden} more · widen pane`, color: "dim" }], width));
      lines.push(affordance);
      return lines;
    }
  }
  lines.push(...valueLines, affordance);
  return lines;
}

function outcomeText(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  switch (state) {
    case "failed":
    case "blocked": return entry.error ?? "";
    case "done": return entry.resultPreview ?? "";
    case "skipped": return "skipped by user";
    default: return "";
  }
}

function runtimeFacts(entry: WorkflowAgentEntry): string {
  const parts: string[] = [];
  if (entry.tokens) parts.push(`${entry.tokens.toLocaleString("en-US")} tokens`);
  if (entry.toolCalls) parts.push(`${entry.toolCalls} tool${entry.toolCalls === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * Transitive downstream nodes a failed node took down: walk `dependents` from the
 * failure and collect every reachable node whose display state is `skipped`. A skip
 * cascades (a skipped node's own dependents skip too), so the walk is transitive, with
 * a visited-set that both bounds it and guards against cycles.
 */
function blastRadius(
  entry: WorkflowAgentEntry, byId: Map<string | number, WorkflowAgentEntry>, active: boolean,
): string[] {
  const skipped: string[] = [];
  const seen = new Set<string | number>([nodeId(entry)]);
  const queue = [...downstreamIds(entry)];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (displayState(node, active) === "skipped") skipped.push(typeof id === "number" ? node.label : id);
    for (const next of downstreamIds(node)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return skipped;
}

/* ------------------------------------------------------------------------- *
 * Detail sections
 * ------------------------------------------------------------------------- */

/**
 * One block of node or stage detail. `navigable` sections accept the detail cursor and
 * expand/collapse via `key`; the complete detail body scrolls as one unit. Control data stays
 * typed here, never smuggled into the rendered strings.
 */
interface DetailSection {
  key: string;
  navigable: boolean;
  lines: WorkflowCardLine[];
}

/**
 * A collapsible detail section: a `muted` label line, then `wrapTextWithAnsi` body lines
 * indented 3 and clamped to width. Collapsed (default) it caps the body at two lines and,
 * when it hid any, ends the second line with a `dim` `⏎ expand (+N)` affordance (room for
 * which is reserved so it survives the width clamp). Expanded, it shows the full wrap. An
 * undefined `bodyColor` leaves the body at the terminal default fg. Shared by Prompt/Outcome.
 */
function collapsibleSection(
  label: string, body: string, bodyColor: WorkflowCardColor | undefined,
  expanded: boolean, enterGlyph: string, width: number,
): WorkflowCardLine[] {
  const inner = Math.max(1, width - 3);
  const wrapped = wrapTextWithAnsi(body, inner);
  const lines: WorkflowCardLine[] = [[], clampLine([{ text: ` ${label}` }], width)];
  const bodySeg = (text: string): WorkflowCardSegment => ({ text: `   ${text}`, ...(bodyColor ? { color: bodyColor } : {}) });
  if (expanded || wrapped.length <= 2) {
    for (const text of wrapped) lines.push(clampLine([bodySeg(text)], width));
    return lines;
  }
  lines.push(clampLine([bodySeg(wrapped[0])], width));
  const hidden = wrapped.length - 2;
  const affordance = `  ${enterGlyph} expand (+${hidden} lines)`;
  const room = Math.max(1, inner - visibleWidth(affordance));
  const line2 = stripTerminalSequences(truncateToWidth(wrapped[1], room, "…"));
  lines.push(clampLine([bodySeg(line2), { text: affordance, color: "dim" }], width));
  return lines;
}


function nodeDetailSections(entry: WorkflowAgentEntry, plan: Pick<PanelPlan, "agents" | "active" | "run" | "ascii" | "width" | "now">, expanded: readonly string[]): DetailSection[] {
  const { agents, active, run, ascii, width, now } = plan;
  const status = lifecycle(entry, run, ascii);
  const line = (text: string, color?: WorkflowCardColor): WorkflowCardLine => clampLine([{ text, ...(color ? { color } : {}) }], width);
  const sections: DetailSection[] = [{ key: "", navigable: false, lines: [
    line(` ${ascii ? "-" : "─"} Selected node ${(ascii ? "-" : "─").repeat(Math.max(1, width - 18))}`), [], line(` ${entry.label}`),
    withTrailing([{ text: ` ${status.word === "done" ? "Completed" : status.word[0].toUpperCase() + status.word.slice(1)}`, color: status.color }, { text: ` · ${[entry.presentation?.kind.replaceAll("_", " "), entry.agentType, entry.model ?? entry.modelId, entry.durationMs !== undefined ? formatDuration(entry.durationMs) : entry.startedAt !== undefined ? formatDuration(Math.max(0, (active ? run.source.task.pausedAt ?? now : entry.lastProgressAt ?? run.source.task.endTime ?? now) - entry.startedAt)) : undefined, entry.cached ? "replayed" : undefined].filter(Boolean).join(" · ")}`, color: "dim" }], "", width),
  ] }];
  const byId = new Map<string | number, WorkflowAgentEntry>(agents.flatMap(agent => [[bindingId(agent), agent] as const, [nodeId(agent, agents), agent] as const]));
  const parent = entry.presentation?.itemIndex !== undefined && parentReference(entry) !== undefined
    ? agents.find(node => (node.historyIndex ?? node.instanceId) === parentReference(entry) && node.presentation?.kind === "fanout") : undefined;
  const deps = upstreamIds(entry).length ? upstreamIds(entry) : parent ? [nodeId(parent)] : [];
  const downstream = downstreamIds(entry).length ? downstreamIds(entry) : parent ? downstreamIds(parent) : [];
  const special = entry.presentation?.historyConnections?.map(edge => ({ ...edge, reference: edge.index }))
    ?? entry.presentation?.connections?.map(edge => ({ ...edge, reference: edge.binding })) ?? [];
  const crossGroup = [...deps, ...downstream].some(id => {
    const other = byId.get(id);
    return other !== undefined && parentReference(other) !== undefined && parentReference(entry) !== undefined
      && parentReference(other) !== parentReference(entry)
      && other !== parent && !(parent && downstreamIds(parent).includes(id));
  });
  const name = (id: string | number) => byId.get(id)?.label ?? String(id);
  const flow = [[], line(" Flow")];
  if (deps.length <= 1 && downstream.length <= 1 && !special.length && !crossGroup) {
    if (deps.length) flow.push(line(`   ${name(deps[0])}`));
    flow.push(line(`      ${ascii ? "`-" : "└─"} this ${entry.presentation?.kind === "agent" ? "agent" : "node"}`));
    if (downstream.length) flow.push(line(`           ${ascii ? "`-" : "└─"} ${name(downstream[0])}`));
  } else {
    for (const text of [
      `    Upstream: ${deps.map(name).join(", ") || "none"}`,
      `    Selected: ${entry.label}`,
      `    Downstream: ${downstream.map(name).join(", ") || "none"}`,
      ...special.map(edge => `    ${edge.direction}: ${name(edge.reference)} (${edge.kind})`),
    ]) flow.push(...wrapTextWithAnsi(text, Math.max(1, width)).map(text => line(text)));
  }
  sections.push({ key: "", navigable: false, lines: flow });
  if (displayState(entry, active) === "failed") sections.push({ key: "", navigable: false, lines: [line(`  Blast radius: ${blastRadius(entry, byId, active).join(", ") || "none yet"}`, "warning")] });
  const detail = run.source.history ? run.readHistoricalDetail?.(entry.index) : undefined;
  const historicalFallback = run.source.history && run.readHistoricalDetail ? HISTORY_ARTIFACT_DETAIL : undefined;
  const prompt = detail?.prompt ?? historicalFallback ?? entry.promptPreview;
  if (prompt?.trim()) sections.push({ key: "prompt", navigable: true, lines: collapsibleSection("Prompt", prompt.trim(), undefined, expanded.includes("prompt"), "Enter", width) });
  const outcome = run.source.history ? detail?.outcome || historicalFallback || entry.resultPreview : outcomeText(entry, displayState(entry, active));
  if (outcome) sections.push({ key: "outcome", navigable: true, lines: collapsibleSection(status.word === "done" ? "Outcome" : "Error", outcome, status.word === "failed" || status.word === "blocked" ? "error" : undefined, expanded.includes("outcome"), "Enter", width) });
  const facts = runtimeFacts(entry);
  const metadata = [[], line(" Metadata"), ...(facts ? [line(`   ${facts}`, "dim")] : [])];
  if (entry.nodeKey) metadata.push(line(`   Key: ${entry.nodeKey}`, "dim"));
  if (entry.instanceId) metadata.push(...(expanded.includes("identity")
    ? wrapTextWithAnsi(`   Instance: ${entry.instanceId}\n   Binding: ${bindingId(entry)}`, Math.max(1, width)).map(text => line(text, "dim"))
    : [withTrailing([{ text: `   Instance: ${entry.instanceId.slice(0, 8)}${ascii ? "..." : "…"}`, color: "dim" }], "Space identity", width)]));
  if (facts || entry.instanceId || entry.nodeKey) sections.push({ key: "identity", navigable: !!entry.instanceId, lines: metadata });
  return sections;
}
function openableRecordId(cursor: Target | undefined, agents: readonly WorkflowAgentEntry[]): string | undefined {
  return cursor?.kind === "node" ? agents.find(agent => nodeId(agent, agents) === cursor.id)?.recordId : undefined;
}
/** Scroll offset that keeps `selectedRow` inside a `cap`-tall window over `length` lines (auto-follow). */
function follow(length: number, selectedRow: number | undefined, scroll: number, cap: number): number {
  const maxScroll = Math.max(0, length - cap);
  let s = clamp(scroll, 0, maxScroll);
  if (selectedRow != null) {
    if (selectedRow < s) s = selectedRow;
    else if (selectedRow >= s + cap) s = selectedRow - cap + 1;
    s = clamp(s, 0, maxScroll);
  }
  return s;
}

function padTo(lines: WorkflowCardLine[], rows: number): WorkflowCardLine[] {
  const out = [...lines];
  while (out.length < rows) out.push([]);
  if (out.length > rows) out.length = rows;
  return out;
}


interface PanelPlan {
  index: number; run: PanelRun; active: boolean; agents: WorkflowAgentEntry[];
  ascii: boolean; width: number; now: number; headerLines: WorkflowCardLine[];
  visible: TreeRow[]; resolvedCursor?: Target; targets: Target[];
  detailSections: DetailSection[]; navigable: DetailSection[];
}
function planPanel(runs: readonly PanelRun[], state: PanelState, opts: PanelOptions): PanelPlan | null {
  if (!runs.length) return null;
  const width = Number.isFinite(opts.width) ? Math.max(0, Math.floor(opts.width)) : 80;
  const ascii = opts.ascii ?? false;
  const now = opts.now ?? Date.now();
  const index = clamp(state.runIndex, 0, runs.length - 1);
  const run = runs[index];
  const active = isActive(run.status);
  const agents = collapse(run.source.progress).agents;
  const tree = presentationTree(agents);
  const visible = visibleTree(tree, state, active, ascii);
  const targets = visible.map(row => row.node.target);
  const resolvedCursor = targets[targetIndex(targets, state.cursor)] ?? targets[0];
  const headerLines = [withTrailing([{ text: ` ${run.name}`, color: "toolTitle" as const, bold: true }], run.status === "killed" ? "STOPPED" : run.status.toUpperCase(), width)];
  // The lifecycle is semantic color, never a duplicate glyph.
  const statusSegment = headerLines[0].at(-1);
  if (statusSegment && headerLines[0].length > 1) statusSegment.color = runStateColor(run.status);
  else headerLines.push(clampLine([{ text: ` ${run.status === "killed" ? "STOPPED" : run.status.toUpperCase()}`, color: runStateColor(run.status) }], width));
  if (runs.length > 1) headerLines.push(clampLine([{ text: ` ${index + 1}/${runs.length} · ${runs.filter((_, i) => i !== index).map(other => other.name).join(" · ")}`, color: "dim" }], width));
  headerLines.push(...graphContextLines(run.source, width, state.expandedSections, opts.rows == null ? undefined : Math.max(2, opts.rows - 8)));
  headerLines.push(clampLine([{ text: ` ${aggregate(agents, tree, run, now)}`, color: "dim" }], width));
  if (state.filter !== "all") headerLines.push(clampLine([{ text: ` Filter: ${state.filter}`, color: "warning" }], width));
  if (agents.some(entry => !entry.presentation)) headerLines.push(clampLine([{ text: " Flat fallback: ownership unavailable for unclassified nodes", color: "dim" }], width));
  if (run.source.history) headerLines.push(...wrapTextWithAnsi(historyDisclosure(run.source.history, !!run.readHistoricalDetail), Math.max(1, width)).map(text => clampLine([{ text, color: "dim" }], width)));
  headerLines.push([]);
  const selected = resolvedCursor?.kind === "node" ? agents.find(entry => nodeId(entry, agents) === resolvedCursor.id) : undefined;
  const detailSections = selected ? nodeDetailSections(selected, { agents, active, run, ascii, width, now }, state.expandedSections) : [];
  return { index, run, active, agents, ascii, width, now, headerLines, visible, resolvedCursor, targets, detailSections, navigable: detailSections.filter(section => section.navigable) };
}
function footerLine(plan: PanelPlan, state: PanelState, runCount: number, range?: string): WorkflowCardLine {
  const { run, ascii, width, resolvedCursor, agents, navigable } = plan;
  const hints = [...(range ? [range] : []), `${ascii ? "up/down" : "↑↓"} ${state.focus === "detail" ? "section" : "select"}`];
  if (navigable.length) hints.push("Enter expand");
  else if (resolvedCursor && resolvedCursor.kind !== "node") hints.push("Enter fold");
  if (state.focus === "roster") hints.push("Space fold");
  else if (navigable.length) hints.push(navigable[clamp(state.detailCursor, 0, navigable.length - 1)].key === "identity" ? "Space identity" : "Space expand");
  hints.push("f filter");
  if (run.source.input !== undefined && !run.source.history) hints.push("e inputs");
  if (runCount > 1) hints.push(`${ascii ? "left/right" : "←→"} run`);
  if (!run.source.history && openableRecordId(resolvedCursor, agents)) hints.push("c convo");
  hints.push(state.focus === "detail" ? "Esc back" : "Esc close");
  return clampLine([{ text: " " + hints.join(" · "), color: "dim" }], width);
}
export function renderPanelLines(runs: readonly PanelRun[], state: PanelState, opts: PanelOptions): WorkflowCardLine[] {
  const width = Number.isFinite(opts.width) ? Math.max(0, Math.floor(opts.width)) : 80;
  const plan = planPanel(runs, state, opts);
  if (!plan) {
    const lines = [[], clampLine([{ text: "  No graph runs in this session yet.", color: "dim" }], width)];
    return opts.rows == null ? lines : padTo(lines, Math.max(0, opts.rows));
  }
  const { lines: roster, selectedRow } = rosterLines(plan, state);
  const detail: WorkflowCardLine[] = [];
  const section = state.focus === "detail" ? plan.navigable[clamp(state.detailCursor, 0, plan.navigable.length - 1)] : undefined;
  let selectedDetail: number | undefined;
  for (const block of plan.detailSections) {
    const title = block.lines.findIndex(line => line.length > 0);
    if (block === section) selectedDetail = detail.length + Math.max(0, title);
    detail.push(...block.lines.map((line, i) => block === section && i === title ? highlightRow(line, width) : line));
  }
  let header = plan.headerLines;
  let body = [...roster, [], [], ...detail];
  let range: string | undefined;
  if (opts.rows !== undefined) {
    const rosterFloor = Math.min(roster.length, 3, Math.max(0, opts.rows - 1));
    header = header.slice(0, Math.max(0, opts.rows - 1 - rosterFloor));
    const capacity = Math.max(0, opts.rows - header.length - 1);
    const detailCap = detail.length ? Math.min(detail.length, Math.max(0, Math.min(capacity - rosterFloor - 2, Math.max(5, Math.floor(capacity * .4))))) : 0;
    const rosterCap = Math.max(0, capacity - detailCap - (detailCap ? 2 : 0));
    const selection = state.scroll === 0 ? selectedRow : undefined;
    const scroll = follow(roster.length, selection, state.scroll, rosterCap);
    const detailScroll = follow(detail.length, state.detailScroll === 0 ? selectedDetail : undefined, state.detailScroll, detailCap);
    const [offset, cap, total] = state.focus === "detail" ? [detailScroll, detailCap, detail.length] : [scroll, rosterCap, roster.length];
    if (total > cap) range = `${Math.min(total, offset + 1)}-${Math.min(total, offset + cap)}/${total}`;
    body = [...roster.slice(scroll, scroll + rosterCap), ...(detailCap ? [[], []] : []), ...detail.slice(detailScroll, detailScroll + detailCap)];
  }
  const content = [...header, ...body];
  const output = opts.rows === undefined ? content : padTo(content, Math.max(0, opts.rows - 1));
  if (opts.rows !== 0) output.push(footerLine(plan, state, runs.length, range));
  return output.map(line => clampLine(line, width));
}
const toggleSection = (keys: readonly string[], key: string): string[] =>
  keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key];

export function applyPanelKey(
  runs: readonly PanelRun[], state: PanelState, data: string, opts: PanelOptions,
): { state: PanelState; lines: WorkflowCardLine[]; close: boolean; action?: { kind: "open"; recordId: string } } {
  const render = (next: PanelState, close = false) => ({ state: next, lines: renderPanelLines(runs, next, opts), close });

  if (matchesKey(data, "escape") || matchesKey(data, "q")) {
    // esc backs out of the detail to the roster first; from the roster it closes.
    if (state.focus === "detail" && runs.length > 0) return render({ ...state, focus: "roster" });
    return render(state, true);
  }
  if (runs.length === 0) return render(state);

  const plan = planPanel(runs, state, opts);
  if (plan == null) return render(state);
  const { index, agents, targets, resolvedCursor, navigable } = plan;

  if (matchesKey(data, "left") || matchesKey(data, "right")) {
    const nextIndex = clamp(index + (matchesKey(data, "right") ? 1 : -1), 0, runs.length - 1);
    if (nextIndex === index) return render(state);
    // Persist the filter across a run switch; stages differ per graph, so reset to the overview.
    return render({
      runIndex: nextIndex, scroll: 0, detailScroll: 0, filter: state.filter,
      collapsedStages: [], collapsedTargets: [], focus: "roster", detailCursor: 0, expandedSections: [],
    });
  }

  if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) {
    const delta = matchesKey(data, "pageDown") ? 5 : -5;
    // In detail focus the page keys scroll the detail zone; in roster focus, the roster.
    if (state.focus === "detail") return render({ ...state, runIndex: index, detailScroll: Math.max(0, state.detailScroll + delta) });
    return render({ ...state, runIndex: index, scroll: Math.max(0, state.scroll + delta) });
  }

  if (matchesKey(data, "f")) {
    const nextFilter: PanelState["filter"] =
      state.filter === "all" ? "running" : state.filter === "running" ? "failed" : "all";
    // If the cursor's target no longer exists under the new filter, snap it to the first target.
    const nextTargets = planPanel(runs, { ...state, filter: nextFilter }, opts)?.targets ?? [];
    const stillVisible = targetIndex(nextTargets, state.cursor) >= 0;
    return render({
      ...state,
      runIndex: index,
      filter: nextFilter,
      scroll: 0,
      detailScroll: 0,
      cursor: stillVisible ? state.cursor : nextTargets[0],
    });
  }

  if (matchesKey(data, "e") && !plan.run.source.history && plan.run.source.input !== undefined) {
    return render({ ...state, runIndex: index, expandedSections: toggleSection(state.expandedSections, "full-inputs") });
  }

  if (matchesKey(data, "enter")) {
    if (state.focus === "detail") {
      if (navigable.length === 0) return render({ ...state, runIndex: index });
      const key = navigable[clamp(state.detailCursor, 0, navigable.length - 1)].key;
      return render({ ...state, runIndex: index, expandedSections: toggleSection(state.expandedSections, key) });
    }
    if (resolvedCursor && resolvedCursor.kind !== "node") return applyPanelKey(runs, state, " ", opts);
    // Roster focus: drill a node with an expandable section into the detail; else stay put.
    if (resolvedCursor?.kind === "node" && navigable.length > 0) {
      return render({ ...state, runIndex: index, focus: "detail", detailCursor: 0, detailScroll: 0, cursor: resolvedCursor });
    }
    return render({ ...state, runIndex: index });
  }

  if (matchesKey(data, "space")) {
    if (state.focus === "detail") {
      if (navigable.length === 0) return render({ ...state, runIndex: index });
      const key = navigable[clamp(state.detailCursor, 0, navigable.length - 1)].key;
      return render({ ...state, runIndex: index, expandedSections: toggleSection(state.expandedSections, key) });
    }
    if (!resolvedCursor) return render(state);
    const row = plan.visible.find(row => sameTarget(row.node.target, resolvedCursor));
    if (!row) return render(state);
    const target = row.node.children.length ? row.node.target : row.parent ?? { kind: "stage", stage: 0 };
    const collapsed = state.collapsedTargets ?? [];
    const next = collapsed.some(item => sameTarget(item, target))
      ? collapsed.filter(item => !sameTarget(item, target)) : [...collapsed, target];
    return render({ ...state, collapsedStages: [], collapsedTargets: next, cursor: target, scroll: 0 });
  }

  const down = matchesKey(data, "down") || matchesKey(data, "j");
  const up = matchesKey(data, "up") || matchesKey(data, "k");
  if (down || up) {
    if (state.focus === "detail") {
      if (navigable.length === 0) return render({ ...state, runIndex: index });
      const next = clamp(state.detailCursor + (down ? 1 : -1), 0, navigable.length - 1);
      return render({ ...state, runIndex: index, detailCursor: next, detailScroll: 0 });
    }
    if (targets.length === 0) return render({ ...state, runIndex: index });
    const current = targetIndex(targets, state.cursor);
    // Unset or stale cursor: down starts at the first target, up stays at the first.
    const nextPos = current < 0 ? 0 : clamp(current + (down ? 1 : -1), 0, targets.length - 1);
    // A fresh node starts its detail from the top of the (collapsed) sections.
    return render({ ...state, runIndex: index, cursor: targets[nextPos], detailCursor: 0, detailScroll: 0, scroll: 0 });
  }

  if (matchesKey(data, "c") && !plan.run.source.history) {
    const recordId = openableRecordId(resolvedCursor, agents);
    // Only a node with a recordId can open; a stage cursor or record-less node leaves `c` unowned.
    if (recordId !== undefined) return { ...render(state), action: { kind: "open", recordId } };
  }

  // A key the panel does not own leaves state unchanged.
  return render(state);
}
