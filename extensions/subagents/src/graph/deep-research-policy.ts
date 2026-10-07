import type { FeedbackDecision, FeedbackGap, FeedbackResult } from "./bounded-feedback.js";
import type { AgentGraph, FanoutResult } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";

export interface LedgerClaim {
  readonly id: string;
  readonly partIds: readonly string[];
  readonly claim: string;
  readonly excerpt: string;
  readonly reference: string;
  readonly source: string;
  readonly sourceKind?: "primary" | "secondary";
  /** Later IDs whose normalized reference and excerpt repeat this claim; their partIds are merged into `partIds`. */
  readonly duplicateIds?: readonly string[];
}
export interface LedgerTask { readonly id: string; readonly item: unknown }
export interface LedgerGap { readonly id: string; readonly partIds: readonly string[]; readonly gap: string }
export interface LedgerFailure { readonly id: string; readonly item: unknown; readonly status: string; readonly error: string }
export interface ResearchLedger {
  readonly claims: readonly LedgerClaim[];
  readonly tasks: readonly LedgerTask[];
  readonly gaps: readonly LedgerGap[];
  readonly failures: readonly LedgerFailure[];
  readonly visited: readonly string[];
}
export interface LedgerRound { readonly iteration: number; readonly results: FanoutResult["results"]; readonly decision?: FeedbackDecision }

// ponytail: gap identity is the exact gapId; a renamed gap evades the limit. Upgrade path: match by `<partId>-` prefix instead.
const GAP_ATTEMPT_LIMIT = 2;

/** Counts `decision.tasks[].gapId` over every iteration except the last (the active round, whose own decision must not count against itself). */
export function gapAttempts(iterations: readonly LedgerRound[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const round of iterations.slice(0, -1)) {
    for (const task of round.decision?.tasks ?? []) counts.set(task.gapId, (counts.get(task.gapId) ?? 0) + 1);
  }
  return counts;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function strings(value: unknown): string[] { return list(value).filter((entry): entry is string => typeof entry === "string"); }

/** URLs compare without fragment, trailing slash, or scheme/host case; other references by trimmed text. */
export function normalizeReference(reference: string): string {
  const trimmed = reference.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try { const url = new URL(trimmed); url.hash = ""; return url.href.replace(/\/+$/, ""); } catch { /* not a URL; compare as text */ }
  }
  return trimmed.replace(/\s+/g, " ");
}
function normalizeExcerpt(excerpt: string): string { return excerpt.trim().replace(/\s+/g, " ").toLowerCase(); }

/** Pure projection of saved worker results; IDs are `r<round>-<item>-<claim>` from position (round 0 = seed). */
export function researchLedger(seed: unknown, iterations: readonly LedgerRound[]): ResearchLedger {
  type Kept = Omit<LedgerClaim, "partIds" | "duplicateIds"> & { partIds: string[]; duplicateIds?: string[] };
  const claims: Kept[] = [];
  const tasks: LedgerTask[] = []; const gaps: LedgerGap[] = []; const failures: LedgerFailure[] = [];
  const kept = new Map<string, Kept>();
  const visited = new Set<string>();
  const rounds = [{ iteration: 0, results: list(record(seed) ? seed.results : undefined) }, ...iterations.map(row => ({ iteration: row.iteration, results: list(row.results) }))];
  for (const round of rounds) {
    round.results.forEach((result, index) => {
      if (!record(result)) return;
      const itemId = `r${round.iteration}-${index + 1}`;
      const partIds = strings(record(result.item) ? result.item.partIds : undefined);
      tasks.push({ id: itemId, item: result.item });
      if (result.status !== "completed") {
        failures.push({ id: itemId, item: result.item, status: text(result.status), error: text(result.error) || `Item ${text(result.status) || "not completed"}` });
        return;
      }
      const output = record(result.output) ? result.output : {};
      for (const gap of strings(output.gaps)) gaps.push({ id: itemId, partIds, gap });
      list(output.claims).forEach((raw, claimIndex) => {
        if (!record(raw)) return;
        const id = `${itemId}-${claimIndex + 1}`;
        const reference = text(raw.reference);
        const normalized = normalizeReference(reference);
        if (normalized) visited.add(normalized);
        for (const url of urlsIn(reference)) visited.add(normalizeReference(url));
        const key = `${normalized}\n${normalizeExcerpt(text(raw.excerpt))}`;
        const first = kept.get(key);
        if (first) {
          first.duplicateIds = [...(first.duplicateIds ?? []), id];
          for (const part of partIds) if (!first.partIds.includes(part)) first.partIds.push(part);
          return;
        }
        const sourceKind = raw.sourceKind === "primary" || raw.sourceKind === "secondary" ? raw.sourceKind : undefined;
        const claim: Kept = { id, partIds: [...partIds], claim: text(raw.claim), excerpt: text(raw.excerpt), reference, source: text(raw.source), ...(sourceKind ? { sourceKind } : {}) };
        kept.set(key, claim); claims.push(claim);
      });
    });
  }
  return { claims, tasks, gaps, failures, visited: [...visited] };
}

function planning(value: unknown): { parts: string[]; seed: unknown } {
  const parts = record(value) ? list(value.parts).map(part => record(part) ? text(part.id) : "") : [];
  if (!parts.length || parts.some(part => !part) || new Set(parts).size !== parts.length) throw new TypeError("planning output must list unique plan part IDs");
  return { parts, seed: record(value) ? value.seed : undefined };
}

/** Evaluator `${feedback}`: the ledger plus the previous decision's gaps, never raw rounds. */
export function evaluatorFeedback(planningOutput: unknown, iterations: readonly LedgerRound[], openGaps: readonly FeedbackGap[]): ResearchLedger & { openGaps: readonly FeedbackGap[]; exhaustedGaps: readonly { id: string; attempts: number }[] } {
  const attempts = gapAttempts(iterations);
  const exhaustedGaps = [...attempts].filter(([, count]) => count >= GAP_ATTEMPT_LIMIT).map(([id, count]) => ({ id, attempts: count }));
  return { ...researchLedger(record(planningOutput) ? planningOutput.seed : undefined, iterations), openGaps, exhaustedGaps };
}

/** Writer `${research}`: the ledger plus terminal bounded-feedback metadata. */
export function writerResearch(planningOutput: unknown, terminal: unknown): ResearchLedger & { terminal: Pick<FeedbackResult, "reason" | "partial" | "gaps" | "counters"> } {
  const result = record(terminal) ? terminal : {};
  const ledger = researchLedger(record(planningOutput) ? planningOutput.seed : undefined, list(result.iterations).filter(record).map(row => ({ iteration: Number(row.iteration), results: list(row.results) as FanoutResult["results"] })));
  return { ...ledger, terminal: { reason: result.reason as FeedbackResult["reason"], partial: result.partial === true, gaps: list(result.gaps) as FeedbackGap[], counters: result.counters as FeedbackResult["counters"] } };
}

/** Appended to work prompts in rounds >= 2; undefined when nothing has been opened yet. */
export function visitedLine(planningOutput: unknown, priorIterations: readonly LedgerRound[]): string | undefined {
  const { visited } = researchLedger(record(planningOutput) ? planningOutput.seed : undefined, priorIterations);
  return visited.length ? `\n\nAlready opened references (do not reopen unless verifying a specific claim): ${JSON.stringify(visited)}` : undefined;
}

export interface DeepResearchOutput {
  readonly graph: AgentGraph;
  readonly stage: "evaluation" | "synthesize";
  /** Completed `planning` output. */
  readonly planning: unknown;
  /** Evaluation: rounds up to and including the current one. Synthesis: ignored in favor of `research`. */
  readonly iterations?: readonly LedgerRound[];
  /** Synthesis: terminal `research` output. */
  readonly research?: unknown;
}

const CLAIM_ID = /(?<![\w-])r\d+-\d+-\d+(?![\w-])/g;
const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/g;

/** URLs found in free text, with trailing punctuation (sentence-ending marks, not URL characters) stripped. */
function urlsIn(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map(url => url.replace(/[.,;:!?]+$/, ""));
}

/** Relational checks after JSON Schema at the structured repair seam; errors become repair prompts. */
export function checkDeepResearchOutput(context: DeepResearchOutput, value: unknown): true | string {
  if (context.graph.semanticPolicy !== "deep-research-v1") return true;
  try {
    const plan = planning(context.planning);
    const output = record(value) ? value : {};
    if (context.stage === "evaluation") {
      const ledger = researchLedger(plan.seed, context.iterations ?? []);
      if (output.decision === "continue") {
        const attempts = gapAttempts(context.iterations ?? []);
        const offending = [...new Set(list(output.tasks).map(task => record(task) ? text(task.gapId) : "").filter(gapId => gapId && (attempts.get(gapId) ?? 0) >= GAP_ATTEMPT_LIMIT))];
        if (offending.length) throw new TypeError(offending.map(id => `gap ${id} already had ${attempts.get(id)} tasks with no closing claim (limit ${GAP_ATTEMPT_LIMIT}): remove its tasks and keep it in gaps as inaccessible; if no task for another gap remains, return decision 'sufficient' with tasks []`).join("; "));
        return true;
      }
      if (output.decision !== "sufficient") return true;
      const gapIds = list(output.gaps).map(gap => record(gap) ? text(gap.id) : "");
      const uncovered = plan.parts.filter(part => !ledger.claims.some(claim => claim.partIds.includes(part) && claim.sourceKind !== "secondary") && !gapIds.some(gap => gap.startsWith(`${part}-`)));
      if (uncovered.length) throw new TypeError(`decision 'sufficient' leaves plan parts with no primary ledger claim and no reported gap: ${uncovered.join(", ")}. Return decision 'continue' with tasks for them, or list each unresolved part as a gap whose id starts with '<partId>-' (for example '${uncovered[0]}-no-evidence').`);
      return true;
    }
    const ledger = writerResearch(context.planning, context.research);
    const known = new Set(ledger.claims.flatMap(claim => [claim.id, ...(claim.duplicateIds ?? [])]));
    const kindById = new Map(ledger.claims.flatMap(claim => [claim.id, ...(claim.duplicateIds ?? [])].map(id => [id, claim.sourceKind] as const)));
    const visited = new Set(ledger.visited);
    const errors: string[] = [];
    const unknownIds = new Set<string>();
    const markdown = text(output.markdown);
    for (const token of markdown.match(CLAIM_ID) ?? []) if (!known.has(token)) unknownIds.add(token);
    for (const finding of list(output.acceptedFindings)) for (const claimId of strings(record(finding) ? finding.claimIds : undefined)) if (!known.has(claimId)) unknownIds.add(claimId);
    const coverage = list(output.verifiedCoverage).filter(record);
    for (const row of coverage) for (const claimId of strings(row.claimIds)) if (!known.has(claimId)) unknownIds.add(claimId);
    if (unknownIds.size) errors.push(`unknown ledger claim IDs: ${[...unknownIds].join(", ")}`);
    const urls = new Set(urlsIn(markdown).filter(url => !visited.has(normalizeReference(url))));
    if (urls.size) errors.push(`markdown cites URLs no ledger claim references: ${[...urls].join(", ")}`);
    const ids = coverage.map(row => text(row.id));
    const missing = plan.parts.filter(part => ids.filter(id => id === part).length !== 1);
    const extra = [...new Set(ids.filter(id => !plan.parts.includes(id)))];
    if (missing.length || extra.length) errors.push(`verifiedCoverage must list each plan part exactly once (${plan.parts.join(", ")})${missing.length ? `; missing or repeated: ${missing.join(", ")}` : ""}${extra.length ? `; unknown: ${extra.join(", ")}` : ""}`);
    const unsupported = coverage.filter(row => row.status === "supported" && !strings(row.claimIds).length).map(row => text(row.id));
    if (unsupported.length) errors.push(`supported coverage requires at least one claimId: ${unsupported.join(", ")}`);
    const secondaryOnly = coverage.filter(row => row.status === "supported" && strings(row.claimIds).length > 0 && strings(row.claimIds).every(claimId => kindById.get(claimId) === "secondary")).map(row => text(row.id));
    if (secondaryOnly.length) errors.push(`supported coverage needs at least one primary claim: ${secondaryOnly.join(", ")}`);
    if (errors.length) throw new TypeError(`${errors.join("; ")}. Cite only ledger claim IDs and their references.`);
    return true;
  } catch (error) {
    if (error instanceof TypeError) return `deep-research-v1: ${error.message}`;
    throw error;
  }
}

/** Reapply the checks to durable completed evaluator and writer outputs. */
export function validateDeepResearchRestore(graph: AgentGraph, state: SchedulerState): void {
  if (graph.semanticPolicy !== "deep-research-v1") return;
  const planningOutput = state.nodes.planning?.output;
  const feedback = state.runtime?.feedback?.research;
  const rounds: LedgerRound[] = [...(feedback?.iterations ?? [])];
  if (feedback?.active) {
    const collected = state.nodes[feedback.active.work]?.output;
    rounds.push({ iteration: feedback.active.iteration, results: list(record(collected) ? collected.results : undefined) as FanoutResult["results"] });
  }
  const checks: [string, DeepResearchOutput][] = rounds.map((_row, index) => [
    feedback?.active && index === rounds.length - 1 ? feedback.active.evaluator : feedback?.iterations[index].evaluator ?? "",
    { graph, stage: "evaluation", planning: planningOutput, iterations: rounds.slice(0, index + 1) },
  ]);
  checks.push(["synthesize", { graph, stage: "synthesize", planning: planningOutput, research: state.nodes.research?.output }]);
  for (const [key, context] of checks) {
    const run = state.nodes[key];
    if (run?.status !== "completed") continue;
    const check = checkDeepResearchOutput(context, run.output);
    if (check !== true) throw new TypeError(`Invalid restored semantic output: ${check}`);
  }
}
