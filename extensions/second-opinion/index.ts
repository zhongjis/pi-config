import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { initLib } from "../lib/index.js";
import { isTui } from "../lib/mode.js";
import { REVIEW_USAGE, parseReviewMode, planCodexReviewJobs, type CodexReviewJob } from "./src/detect.js";
import { preflight } from "./src/preflight.js";
import { runCodexReview } from "./src/run.js";
import {
  buildScopedReviewPrompt,
  buildSessionScopePrompt,
  collectSessionWritePaths,
  type SessionReviewScope,
} from "./src/session.js";
import { extractToolText, renderToolCall, renderToolExpanded, renderToolSummary } from "../lib/tool-output.js";

interface CommandArgumentCompletion {
  value: string;
  label: string;
}

const SESSION_SCOPE_TOOL = "codex_review_session_scope";

const COMPLETIONS: CommandArgumentCompletion[] = [
  { value: "session", label: "session — agent chooses scoped session review" },
];

type ReviewRunResult = { ok: boolean; review: string };
type AddressChoice = "critical" | "all" | "tasks" | "no";

let sessionToolActivatedByCommand = false;

function gitRunner(pi: ExtensionAPI) {
  return async (gitArgs: string[], cwd: string): Promise<string | null> => {
    const r = await pi.exec("git", gitArgs, { cwd });
    return r.code === 0 ? (r.stdout || "").trim() : null;
  };
}

function formatReviewResults(results: Array<{ label: string; review: string }>): string {
  if (results.length === 1) return results[0].review;
  return results.map((result) => `## ${result.label}\n\n${result.review}`).join("\n\n---\n\n");
}

async function runReviewJobs(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  jobs: CodexReviewJob[],
  cwd: string,
  labelPrefix = "",
): Promise<ReviewRunResult> {
  const results: Array<{ label: string; review: string }> = [];

  for (const job of jobs) {
    const label = labelPrefix ? `${labelPrefix} — ${job.label}` : job.label;
    if (isTui(ctx)) {
      ctx.ui.setStatus("codex-review", `Running codex review: ${label}…`);
    }

    const result = await runCodexReview(pi, ctx, job.argv, cwd, `codex review: ${label}`);
    if (!result.ok) {
      return { ok: false, review: `${label}: ${result.review}` };
    }
    results.push({ label, review: result.review });
  }

  return { ok: true, review: formatReviewResults(results) };
}

function postReview(pi: ExtensionAPI, review: string): void {
  pi.sendMessage({
    customType: "second-opinion",
    content: review,
    display: true,
  });
}

function buildAddressCommentsPrompt(choice: Exclude<AddressChoice, "no">, scopeSummary: string): string {
  const action = choice === "tasks"
    ? "Create tasks for actionable Codex review comments. Do not edit files."
    : choice === "critical"
      ? "Address only critical/high-confidence actionable Codex review comments."
      : "Address all actionable Codex review comments.";

  return [
    action,
    "",
    "Use the latest `second-opinion` message as the review source.",
    "",
    "Scope reviewed:",
    scopeSummary,
    "",
    "Workflow adapted from address-comments:",
    "1. Read the review end-to-end before acting.",
    "2. Classify each comment as fix, disagree, or needs-user.",
    "3. For fix: make the smallest code change that addresses the concern; avoid unrelated refactors.",
    "4. For disagree: state the concise technical reason in the final summary.",
    "5. For needs-user or broad/ambiguous changes: ask before changing code.",
    "6. Do not commit or push unless explicitly asked.",
    "7. Verify with focused diagnostics/tests/typechecks.",
    "8. Summarize fixed, disagreed, left open, files changed, verification run.",
  ].join("\n");
}

async function askAddressChoice(pi: ExtensionAPI, ctx: any): Promise<AddressChoice> {
  if (typeof ctx.ui?.select !== "function") return "no";

  pi.events?.emit?.("user-prompted", { tool: "codex-review-address-comments" });
  const choice = await ctx.ui.select("Address Codex review comments?", [
    "Address critical/high only",
    "Address all actionable",
    "Create tasks only",
    "No",
  ]);

  if (choice === "Address critical/high only") return "critical";
  if (choice === "Address all actionable") return "all";
  if (choice === "Create tasks only") return "tasks";
  return "no";
}

async function offerAddressComments(
  pi: ExtensionAPI,
  ctx: any,
  scopeSummary: string,
): Promise<boolean> {
  const choice = await askAddressChoice(pi, ctx);
  if (choice === "no") return false;

  pi.sendUserMessage(buildAddressCommentsPrompt(choice, scopeSummary), {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  return true;
}

function activateSessionTool(pi: ExtensionAPI): void {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;

  const active = pi.getActiveTools();
  if (!active.includes(SESSION_SCOPE_TOOL)) {
    pi.setActiveTools([...active, SESSION_SCOPE_TOOL]);
    sessionToolActivatedByCommand = true;
  }
}

function deactivateSessionTool(pi: ExtensionAPI): void {
  if (!sessionToolActivatedByCommand) return;
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;

  pi.setActiveTools(pi.getActiveTools().filter((tool) => tool !== SESSION_SCOPE_TOOL));
  sessionToolActivatedByCommand = false;
}

async function runDefaultReview(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const ok = await preflight(pi, ctx);
  if (!ok) return;

  let jobs: CodexReviewJob[];
  try {
    jobs = await planCodexReviewJobs(gitRunner(pi), ctx.cwd);
  } catch (err) {
    ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    return;
  }

  if (jobs.length === 0) {
    ctx.ui.notify(`No branch or dirty changes to review in ${ctx.cwd}`, "info");
    return;
  }

  const result = await runReviewJobs(pi, ctx, jobs, ctx.cwd);
  if (!result.ok) {
    ctx.ui.notify(`Codex review failed: ${result.review.slice(0, 200)}`, "error");
    return;
  }

  postReview(pi, result.review);
  ctx.ui.notify("Codex review complete", "info");
  await offerAddressComments(pi, ctx, `Current repo: ${ctx.cwd}`);
}

async function startSessionReview(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const ok = await preflight(pi, ctx, { requireGit: false });
  if (!ok) return;

  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  const paths = collectSessionWritePaths(entries);
  activateSessionTool(pi);
  pi.sendUserMessage(buildSessionScopePrompt(paths, ctx.cwd), {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  ctx.ui.notify(`Codex session review requested (${paths.length} path hint(s))`, "info");
}

function parseScopes(params: unknown): { reason: string; repos: SessionReviewScope[] } {
  const record = params as { reason?: unknown; repos?: unknown };
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  const rawRepos = Array.isArray(record.repos) ? record.repos : [];
  const repos = rawRepos.map((raw) => {
    const item = raw as { path?: unknown; include?: unknown; exclude?: unknown; notes?: unknown };
    return {
      path: typeof item.path === "string" ? item.path.trim() : "",
      include: Array.isArray(item.include)
        ? item.include.map((path) => String(path).trim()).filter(Boolean)
        : [],
      exclude: Array.isArray(item.exclude)
        ? item.exclude.map((path) => String(path).trim()).filter(Boolean)
        : [],
      notes: typeof item.notes === "string" ? item.notes.trim() : undefined,
    };
  });

  return { reason, repos };
}

function validateScopes(scopes: SessionReviewScope[]): string | null {
  if (scopes.length === 0) return "At least one repo scope is required.";

  for (const scope of scopes) {
    if (!scope.path) return "Every repo scope needs a path.";
    if (!isAbsolute(scope.path)) return `Repo path must be absolute: ${scope.path}`;
    if (scope.include.length === 0) return `Repo scope needs at least one included path: ${scope.path}`;
  }

  return null;
}

async function runScopedSessionReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  reason: string,
  scopes: SessionReviewScope[],
): Promise<ReviewRunResult> {
  const results: Array<{ label: string; review: string }> = [];
  const skipped: string[] = [];

  for (const scope of scopes) {
    const ok = await preflight(pi, ctx, { cwd: scope.path, requireGit: true });
    if (!ok) return { ok: false, review: `Preflight failed for ${scope.path}` };

    const prompt = buildScopedReviewPrompt(scope, reason);
    let jobs: CodexReviewJob[];
    try {
      jobs = await planCodexReviewJobs(gitRunner(pi), scope.path, { prompt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Could not determine a base ref")) {
        skipped.push(`${scope.path}: ${message}`);
        continue;
      }
      return { ok: false, review: `${scope.path}: ${message}` };
    }
    if (jobs.length === 0) {
      skipped.push(`${scope.path}: no branch or dirty changes`);
      continue;
    }

    const result = await runReviewJobs(pi, ctx, jobs, scope.path, scope.path);
    if (!result.ok) return result;

    results.push({ label: scope.path, review: result.review });
  }

  if (results.length === 0) {
    return { ok: false, review: skipped.join("\n") || "No scoped changes to review." };
  }

  const review = formatReviewResults(results);
  return {
    ok: true,
    review: skipped.length > 0 ? `${review}\n\n---\n\nSkipped:\n${skipped.map((item) => `- ${item}`).join("\n")}` : review,
  };
}

export default function secondOpinion(pi: ExtensionAPI) {
  initLib(pi);

  const RepoScopeSchema = Type.Object({
    path: Type.String({ description: "Absolute path to git repo root to review." }),
    include: Type.Array(Type.String({ description: "Path in scope, relative to repo root when practical." })),
    exclude: Type.Optional(Type.Array(Type.String({ description: "Changed path intentionally excluded from review." }))),
    notes: Type.Optional(Type.String({ description: "Short rationale or context for this repo scope." })),
  });

  const SessionScopeParams = Type.Object({
    reason: Type.String({ description: "Why this scope is the right session review target." }),
    repos: Type.Array(RepoScopeSchema, { description: "One or more repo scopes to review." }),
  });

  pi.registerTool({
    name: SESSION_SCOPE_TOOL,
    label: "Codex session review scope",
    description: [
      "Run Codex review for a confirmed session scope.",
      "Use only after /codex:review session asks you to choose scope.",
      "Paths are prompt scope only; this tool does not pass hard path filters to Codex.",
    ].join("\n"),
    parameters: SessionScopeParams,
    renderCall(args, theme, _context) {
      const parsed = parseScopes(args);
      const repoCount = parsed.repos.length;
      const reason = parsed.reason || "no reason";
      return renderToolCall(
        SESSION_SCOPE_TOOL,
        `${repoCount} repo${repoCount !== 1 ? "s" : ""} · reason: ${reason}`,
        theme,
      );
    },
    renderResult(result, options, theme, context) {
      const raw = extractToolText(result);
      if (options.expanded) return renderToolExpanded(raw);

      const parsed = parseScopes(context?.args ?? {});
      const repoCount = parsed.repos.length;
      const summary = `scope: ${repoCount} repo${repoCount !== 1 ? "s" : ""} · reason: ${parsed.reason || "not provided"}`;
      if (raw.startsWith("Codex review failed:")) {
        return renderToolSummary(["status: failed", summary, raw], theme, { expandable: true, expandLabel: "diagnostics" });
      }
      if (raw === "Codex scoped review complete and posted. Address-comments follow-up sent.") {
        return renderToolSummary(["status: complete · posted", summary, "next: address-comments follow-up sent"], theme, {
          expandable: true,
          expandLabel: "full result",
        });
      }
      if (raw === "Codex scoped review complete and posted.") {
        return renderToolSummary(["status: complete · posted", summary, "next: no follow-up requested"], theme, {
          expandable: true,
          expandLabel: "full result",
        });
      }
      if (raw.startsWith("At least one repo scope") || raw.startsWith("Every repo scope") || raw.startsWith("Repo path") || raw.startsWith("Repo scope")) {
        return renderToolSummary(["status: blocked · invalid scope", summary, raw], theme, { expandable: true, expandLabel: "full result" });
      }
      return renderToolSummary([raw ? `result: ${raw}` : "result: no review output", summary], theme, {
        expandable: raw.length > 0,
        expandLabel: "full result",
      });
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const { reason, repos } = parseScopes(params);
        const invalid = validateScopes(repos);
        if (invalid) return { content: [{ type: "text", text: invalid }] };

        const result = await runScopedSessionReview(pi, ctx as ExtensionCommandContext, reason, repos);
        if (!result.ok) {
          return { content: [{ type: "text", text: `Codex review failed: ${result.review}` }] };
        }

        postReview(pi, result.review);
        const scopeSummary = repos
          .map((repo) => [`Repo: ${repo.path}`, "Include:", ...repo.include.map((path) => `- ${path}`)].join("\n"))
          .join("\n\n");
        const followUpSent = await offerAddressComments(pi, ctx, scopeSummary);
        return {
          content: [
            {
              type: "text",
              text: followUpSent
                ? "Codex scoped review complete and posted. Address-comments follow-up sent."
                : "Codex scoped review complete and posted.",
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      } finally {
        deactivateSessionTool(pi);
      }
    },
  });

  pi.registerCommand("codex:review", {
    description: "Run codex review on branch and dirty changes, or start session-scoped review",
    getArgumentCompletions: (prefix: string): CommandArgumentCompletion[] | null => {
      const p = prefix.trim().toLowerCase();
      const filtered = COMPLETIONS.filter((c) => c.value.startsWith(p));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const mode = parseReviewMode(args);
      if (mode.kind === "invalid") {
        ctx.ui.notify(`${mode.reason}. ${REVIEW_USAGE}`, "error");
        return;
      }

      if (mode.kind === "session") {
        await startSessionReview(pi, ctx);
        return;
      }

      await runDefaultReview(pi, ctx);
    },
  });
}
