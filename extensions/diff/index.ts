/**
 * Diff Extension
 *
 * /diff opens hunk (https://github.com/modem-dev/hunk) to review git changes.
 * Suspends pi's TUI, hands the terminal to hunk, then resumes once hunk exits.
 * After the review, any inline comments left in hunk are harvested and handed
 * to the agent so it can address them.
 *
 * Subcommands:
 *   /diff            working-tree changes (default)
 *   /diff staged     staged changes (alias: cached)
 *   /diff base       unpushed work — working tree vs your tracking upstream (@{upstream})
 *   /diff pr [<ref>] the whole PR — vs the integration branch (origin default;
 *                    pass <ref> to override, e.g. develop or upstream/main)
 *   /diff pr-walkthrough [<ref>]  agent annotates the PR (agent-context sidecar)
 *                    then opens the annotated review in hunk
 *   /diff commit     the most recent commit
 *   /diff stash      the latest stash entry
 *   /diff <ref>      working tree compared against a ref (HEAD, branch, sha)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { isTui } from "../lib/mode.js";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { Type } from "typebox";

interface CommandArgumentCompletion {
  value: string;
  label: string;
}

export interface HunkComment {
  file: string;
  line: number | null;
  summary: string;
  source: string | null;
}

interface HunkRawComment {
  filePath?: string;
  file_path?: string;
  file?: string;
  newLine?: number | string;
  new_line?: number | string;
  oldLine?: number | string;
  old_line?: number | string;
  summary?: string;
  comment?: string;
  noteId?: string;
  commentId?: string;
  source?: string;
  newRange?: number[];
  body?: string;
  line?: number | string;
}

// Parse `hunk session comment list --json`. Handles both the legacy schema
// (summary/line/commentId, no source) and the new schema
// (body/newRange/noteId/source), plus {comments:[...]} and bare-array shapes.
// Returns null when stdout is not valid JSON (query/parse failure); returns []
// when the JSON is valid but holds no usable comments (success-empty).
export function parseHunkComments(stdout: string): HunkComment[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const arr: HunkRawComment[] = Array.isArray(raw)
    ? (raw as HunkRawComment[])
    : ((raw as { comments?: HunkRawComment[] })?.comments ?? []);
  return arr
    .map((c) => {
      const file = String(c.filePath ?? c.file_path ?? c.file ?? "");
      const lineValue =
        Array.isArray(c.newRange) && c.newRange.length
          ? Number(c.newRange[0])
          : Number(c.newLine ?? c.new_line ?? c.line ?? c.oldLine ?? c.old_line ?? NaN);
      const line = Number.isFinite(lineValue) ? lineValue : null;
      const summary = String(c.body ?? c.summary ?? c.comment ?? "").trim();
      const source = c.source != null ? String(c.source) : null;
      return { file, line, summary, source };
    })
    .filter((c) => c.file !== "" && c.summary !== "");
}

// Echo-prevention: keep only human-authored notes. Legacy comments have no
// source (null) and are always human; new-schema notes must be source==="user".
// Agent/ai/mcp notes are dropped so the agent never re-ingests its own output.
export function keepUserAuthored(comments: HunkComment[]): HunkComment[] {
  return comments.filter((c) => c.source === null || c.source === "user");
}

// Keep the latest SUCCESSFUL snapshot. A null `next` means the poll failed —
// keep the previous snapshot. An array `next` (even empty) is a success and
// REPLACES the previous one (comment list returns the full set each call).
export function mergeSnapshot(
  prev: HunkComment[] | null,
  next: HunkComment[] | null,
): HunkComment[] | null {
  return next === null ? prev : next;
}

// Format harvested comments into a prompt instructing the agent to act on them.
export function formatReviewPrompt(comments: HunkComment[]): string {
  const lines = comments.map(
    (c) => `- ${c.file}${c.line ? `:${c.line}` : ""} — ${c.summary}`,
  );
  return [
    "I left these inline review comments in hunk. Address each one in the code:",
    "",
    ...lines,
  ].join("\n");
}

const SUBCOMMANDS: CommandArgumentCompletion[] = [
  { value: "staged", label: "staged — review staged changes" },
  { value: "base", label: "base — unpushed work vs your tracking upstream (@{upstream})" },
  { value: "pr", label: "pr — the whole PR vs the integration branch (/diff pr <ref> to override)" },
  { value: "pr-walkthrough", label: "pr-walkthrough — agent annotates the PR, then opens the review" },
  { value: "commit", label: "commit — review the most recent commit" },
  { value: "stash", label: "stash — review the latest stash entry" },
];

const USAGE =
  "Usage: /diff | staged | base | pr [<ref>] | pr-walkthrough [<ref>] | commit | stash | <ref>";

export default function (pi: ExtensionAPI) {
  // Run a git command; return trimmed stdout, or null when git exits non-zero.
  const git = async (args: string[], cwd: string): Promise<string | null> => {
    const r = await pi.exec("git", args, { cwd });
    return r.code === 0 ? (r.stdout || "").trim() : null;
  };

  // Resolve the base ref for `/diff base`: the branch's tracking upstream
  // (@{upstream}) — "what isn't on my remote yet" — falling back to origin's
  // default branch when the branch has no tracking branch.
  const resolveUpstream = async (cwd: string): Promise<string | null> => {
    const tracking = await git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      cwd,
    );
    if (tracking) return tracking;
    const originHead = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
    if (originHead) return originHead.replace(/^refs\/remotes\//, "");
    for (const candidate of ["origin/main", "origin/master"]) {
      if (await git(["rev-parse", "--verify", "--quiet", candidate], cwd)) return candidate;
    }
    return null;
  };

  // Resolve the PR base for `/diff pr` when no explicit ref is given: origin's
  // default branch, falling back to origin/main / origin/master. Deliberately
  // ignores @{upstream} — a pushed feature branch's upstream is itself.
  const resolvePrBase = async (cwd: string): Promise<string | null> => {
    const originHead = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
    if (originHead) return originHead.replace(/^refs\/remotes\//, "");
    for (const candidate of ["origin/main", "origin/master"]) {
      if (await git(["rev-parse", "--verify", "--quiet", candidate], cwd)) return candidate;
    }
    return null;
  };

  // Harvest inline review comments from the LIVE hunk session for this repo.
  // hunk deregisters the session the instant its TUI quits, so this must run
  // while hunk is still open. Returns null on query/parse failure; [] when the
  // session has no human comments; otherwise the human-authored comments.
  const harvestHunkComments = async (repoRoot: string): Promise<HunkComment[] | null> => {
    let r = await pi.exec(
      "hunk",
      ["session", "comment", "list", "--repo", repoRoot, "--type", "all", "--json"],
      { cwd: repoRoot, timeout: 3000 },
    );
    if (r.code !== 0 || !r.stdout) {
      // Fall back to legacy hunk without --type support.
      r = await pi.exec(
        "hunk",
        ["session", "comment", "list", "--repo", repoRoot, "--json"],
        { cwd: repoRoot, timeout: 3000 },
      );
    }
    if (r.code !== 0 || !r.stdout) return null;
    const parsed = parseHunkComments(r.stdout);
    if (parsed === null) return null;
    return keepUserAuthored(parsed);
  };

  // Build the prompt that kicks off an agent-narrated PR walkthrough: analyze the
  // diff, write a hunk agent-context sidecar, then call open_pr_walkthrough.
  const buildWalkthroughPrompt = (sha: string, base: string, sidecarPath: string): string =>
    [
      `Give me a guided walkthrough of this PR (working tree vs ${base}, merge-base ${sha}).`,
      "",
      "Steps:",
      `1. Inspect the diff: run \`git diff ${sha}\` (try --stat first, then read the hunks that matter).`,
      `2. Write a hunk agent-context sidecar to this exact path: ${sidecarPath}`,
      "   JSON schema (line numbers are on the NEW side of each file):",
      "   {",
      '     "version": 1,',
      '     "summary": "<one-line PR summary>",',
      '     "files": [',
      '       { "path": "<repo-relative path>", "summary": "<what changed in this file>",',
      '         "annotations": [',
      '           { "newRange": [<startLine>, <endLine>], "summary": "<what this hunk does>", "rationale": "<why it matters / what to watch>" }',
      "         ] }",
      "     ]",
      "   }",
      "3. Annotate what a reviewer would not spot on their own — risk, intent, structure. Do not comment every hunk.",
      `4. Then call the open_pr_walkthrough tool with { "sidecarPath": "${sidecarPath}", "sha": "${sha}" } to open the annotated review.`,
    ].join("\n");

  // Suspend pi's TUI, hand the terminal to hunk with the given args, then resume.
  // Pattern mirrors extensions/modes/src/plan-approval.ts (refineInSystemEditor).
  // Shared by the /diff command and the open_pr_walkthrough tool.
  const launchHunk = async (
    ctx: {
      cwd: string;
      ui: {
        custom: <T>(
          render: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => unknown,
        ) => Promise<T>;
      };
    },
    hunkArgs: string[],
  ): Promise<{ error?: string; comments: HunkComment[] }> => {
    const repoRoot = (await git(["rev-parse", "--show-toplevel"], ctx.cwd)) || ctx.cwd;
    let launchError: string | undefined;
    let latest: HunkComment[] | null = null;
    await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
      let finished = false;
      let polling = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      // Single-fire teardown: exit the alternate screen, restore pi's TUI, and
      // resolve exactly once (child error/close and spawn failure all route here).
      const finish = () => {
        if (finished) return;
        finished = true;
        if (poll) clearInterval(poll);
        process.stdout.write("\x1b[?1049l");
        tui.start();
        tui.requestRender(true);
        done();
      };
      try {
        tui.stop();
        // Enter alternate screen so hunk output doesn't pollute scrollback.
        process.stdout.write("\x1b[?1049h");
        const child = spawn("hunk", hunkArgs, {
          stdio: "inherit",
          cwd: ctx.cwd,
          shell: process.platform === "win32",
        });
        // Poll the LIVE session while hunk is open (grace period is 0 on quit).
        // The in-flight guard prevents overlapping queries; snapshots REPLACE.
        poll = setInterval(() => {
          if (polling || finished) return;
          polling = true;
          harvestHunkComments(repoRoot)
            .then((snap) => {
              if (!finished) latest = mergeSnapshot(latest, snap);
            })
            .catch(() => {})
            .finally(() => {
              polling = false;
            });
        }, 600);
        child.on("error", (err) => {
          launchError = err.message;
          finish();
        });
        child.on("close", () => finish());
      } catch (e) {
        launchError = e instanceof Error ? e.message : String(e);
        finish();
      }
      // Placeholder component — never visible, the TUI is stopped synchronously.
      return { width: 0, height: 0, draw() {} } as any;
    });
    return { error: launchError, comments: latest ?? [] };
  };

  pi.registerCommand("diff", {
    description: "Review git changes in hunk (/diff | staged | base | pr | commit | stash | <ref>)",
    getArgumentCompletions: (prefix: string): CommandArgumentCompletion[] | null => {
      const p = prefix.trim().toLowerCase();
      const filtered = SUBCOMMANDS.filter((s) => s.value.startsWith(p));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      if (!isTui(ctx)) {
        ctx.ui.notify("diff requires interactive (TUI) mode", "error");
        return;
      }

      const arg = (args || "").trim();
      const parts = arg.split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "").toLowerCase();
      let hunkArgs: string[];

      if (!arg) {
        // Default: working tree. Bail early when there is nothing to review.
        const status = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
        if (status.code !== 0) {
          ctx.ui.notify(`git status failed: ${status.stderr}`, "error");
          return;
        }
        if (!status.stdout || !status.stdout.trim()) {
          ctx.ui.notify("No changes in working tree", "info");
          return;
        }
        hunkArgs = ["diff"];
      } else if (sub === "staged" || sub === "cached") {
        // `git diff --cached --quiet` exits 0 when nothing is staged.
        const staged = await pi.exec("git", ["diff", "--cached", "--quiet"], { cwd: ctx.cwd });
        if (staged.code === 0) {
          ctx.ui.notify("No staged changes", "info");
          return;
        }
        hunkArgs = ["diff", "--staged"];
      } else if (sub === "base") {
        const upstream = await resolveUpstream(ctx.cwd);
        if (!upstream) {
          ctx.ui.notify("Could not determine an upstream branch for /diff base", "error");
          return;
        }
        const sha = await git(["merge-base", "HEAD", upstream], ctx.cwd);
        if (!sha) {
          ctx.ui.notify(`Could not compute merge-base against ${upstream}`, "error");
          return;
        }
        hunkArgs = ["diff", sha];
      } else if (sub === "pr" || sub === "pr-walkthrough") {
        // PR-style: working tree vs the merge-base with the integration branch.
        if (parts.length > 2) {
          ctx.ui.notify(`Usage: /diff ${sub} [<ref>]\n${USAGE}`, "error");
          return;
        }
        const explicit = parts[1];
        let base: string | null;
        if (explicit) {
          const valid = await git(["rev-parse", "--verify", "--quiet", `${explicit}^{commit}`], ctx.cwd);
          if (!valid) {
            ctx.ui.notify(`Unknown ref: ${explicit}`, "error");
            return;
          }
          base = explicit;
        } else {
          base = await resolvePrBase(ctx.cwd);
          if (!base) {
            ctx.ui.notify(
              "Could not determine the PR base branch (no origin default). Try /diff pr <ref>",
              "error",
            );
            return;
          }
        }
        const sha = await git(["merge-base", "HEAD", base], ctx.cwd);
        if (!sha) {
          ctx.ui.notify(`Could not compute merge-base against ${base}`, "error");
          return;
        }
        if (sub === "pr-walkthrough") {
          // Phase A: hand off to the agent to analyze the diff and write the
          // agent-context sidecar; it opens the review via open_pr_walkthrough.
          // Force-enable the agent-only tool for this session. It is registered
          // but intentionally NOT in any mode's extension_tools allowlist, so the
          // agent can only reach it once this command runs. pi.setActiveTools can
          // activate any registered tool, and the modes allowlist is re-applied
          // only on session_start / mode switch — so this survives the next turn.
          const active = pi.getActiveTools();
          if (!active.includes("open_pr_walkthrough")) {
            pi.setActiveTools([...active, "open_pr_walkthrough"]);
          }
          const sidecarPath = `${tmpdir()}/pi-diff-walkthrough-${sha}.json`;
          const prompt = buildWalkthroughPrompt(sha, base, sidecarPath);
          const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
          if (idle) {
            pi.sendUserMessage(prompt);
          } else {
            pi.sendUserMessage(prompt, { deliverAs: "followUp" });
          }
          ctx.ui.notify(
            `Walkthrough: analyzing the PR vs ${base} — I'll open hunk once the notes are ready`,
            "info",
          );
          return;
        }
        hunkArgs = ["diff", sha];
      } else if (sub === "commit") {
        hunkArgs = ["show"];
      } else if (sub === "stash") {
        hunkArgs = ["stash", "show"];
      } else {
        // Treat the argument as a git ref; validate before handing it to hunk.
        const valid = await git(["rev-parse", "--verify", "--quiet", `${arg}^{commit}`], ctx.cwd);
        if (!valid) {
          ctx.ui.notify(`Unknown ref or subcommand: ${arg}\n${USAGE}`, "error");
          return;
        }
        hunkArgs = ["diff", arg];
      }

      const { error: launchError, comments } = await launchHunk(ctx, hunkArgs);
      if (launchError) {
        ctx.ui.notify(`Failed to launch hunk: ${launchError}`, "error");
        return;
      }
      if (comments.length > 0) {
        const prompt = formatReviewPrompt(comments);
        const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
        if (idle) {
          pi.sendUserMessage(prompt);
        } else {
          pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        }
        ctx.ui.notify(`Picked up ${comments.length} hunk review comment(s)`, "info");
      }
    },
  });

  // open_pr_walkthrough — Phase B of /diff pr-walkthrough. The agent calls this
  // after writing the agent-context sidecar; it launches hunk with the notes
  // preloaded, then returns any comments the user leaves so the agent can act.
  const WalkthroughParams = Type.Object({
    sidecarPath: Type.String({
      description: "Absolute path to the agent-context JSON sidecar you wrote.",
    }),
    sha: Type.String({
      description: "Merge-base commit to diff the working tree against (from /diff pr-walkthrough).",
    }),
  });

  pi.registerTool({
    name: "open_pr_walkthrough",
    label: "Open PR walkthrough",
    description: [
      "Open hunk showing the PR diff with your pre-written review annotations inline.",
      "Call this only after writing the agent-context sidecar that /diff pr-walkthrough asked for.",
      "Returns any comments the user leaves during the review so you can address them.",
    ].join("\n"),
    parameters: WalkthroughParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!isTui(ctx)) {
        return {
          content: [{ type: "text", text: "open_pr_walkthrough requires interactive (TUI) mode." }],
        };
      }
      const sidecarPath = String((params as { sidecarPath?: string }).sidecarPath ?? "");
      const sha = String((params as { sha?: string }).sha ?? "");
      if (!sidecarPath || !existsSync(sidecarPath)) {
        return {
          content: [
            {
              type: "text",
              text: `Sidecar not found at ${sidecarPath || "(empty path)"}. Write the agent-context JSON first, then call open_pr_walkthrough again.`,
            },
          ],
        };
      }
      if (!sha) {
        return { content: [{ type: "text", text: "Missing sha to diff against." }] };
      }
      pi.events.emit("user-prompted", { tool: "open_pr_walkthrough" });
      const { error: launchError, comments } = await launchHunk(ctx, [
        "diff",
        sha,
        "--agent-context",
        sidecarPath,
        "--agent-notes",
      ]);
      if (launchError) {
        return { content: [{ type: "text", text: `Failed to launch hunk: ${launchError}` }] };
      }
      // Review opened — retire the tool from the active set until the next
      // /diff pr-walkthrough re-enables it (keeps the agent's tool list clean).
      pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "open_pr_walkthrough"));
      if (comments.length === 0) {
        return {
          content: [{ type: "text", text: "Walkthrough closed — the user left no comments." }],
        };
      }
      return { content: [{ type: "text", text: formatReviewPrompt(comments) }] };
    },
  });
}
