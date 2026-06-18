/**
 * Diff Extension
 *
 * /diff opens hunk (https://github.com/modem-dev/hunk) to review git changes.
 * Suspends pi's TUI, hands the terminal to hunk, then resumes once hunk exits.
 *
 * Subcommands:
 *   /diff            working-tree changes (default)
 *   /diff staged     staged changes (alias: cached)
 *   /diff base       changes since the branch diverged from its upstream
 *   /diff commit     the most recent commit
 *   /diff stash      the latest stash entry
 *   /diff <ref>      working tree compared against a ref (HEAD, branch, sha)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { isTui } from "../lib/mode.js";

interface CommandArgumentCompletion {
  value: string;
  label: string;
}

const SUBCOMMANDS: CommandArgumentCompletion[] = [
  { value: "staged", label: "staged — review staged changes" },
  { value: "base", label: "base — review changes since the branch diverged from upstream" },
  { value: "commit", label: "commit — review the most recent commit" },
  { value: "stash", label: "stash — review the latest stash entry" },
];

const USAGE =
  "Usage: /diff | /diff staged | /diff base | /diff commit | /diff stash | /diff <ref>";

export default function (pi: ExtensionAPI) {
  // Run a git command; return trimmed stdout, or null when git exits non-zero.
  const git = async (args: string[], cwd: string): Promise<string | null> => {
    const r = await pi.exec("git", args, { cwd });
    return r.code === 0 ? (r.stdout || "").trim() : null;
  };

  // Resolve the upstream ref for `/diff base`: prefer the tracking branch,
  // else fall back to origin's default branch.
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

  pi.registerCommand("diff", {
    description: "Review git changes in hunk (/diff | staged | base | commit | stash | <ref>)",
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
      const sub = arg.toLowerCase();
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

      // Suspend pi's TUI, hand the terminal to hunk, then resume.
      // Pattern mirrors extensions/modes/src/plan-approval.ts (refineInSystemEditor).
      let launchError: string | undefined;
      await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
        try {
          tui.stop();
          // Enter alternate screen so hunk output doesn't pollute scrollback.
          process.stdout.write("\x1b[?1049h");
          const result = spawnSync("hunk", hunkArgs, {
            stdio: "inherit",
            cwd: ctx.cwd,
            shell: process.platform === "win32",
          });
          if (result.error) {
            launchError = result.error.message;
          }
        } finally {
          // Exit alternate screen, then restore pi's TUI.
          process.stdout.write("\x1b[?1049l");
          tui.start();
          tui.requestRender(true);
        }
        // Resolve after the TUI is fully restored — avoids a "Working..." flash.
        done();
        // Placeholder component — never visible, the TUI is stopped synchronously.
        return { width: 0, height: 0, draw() {} } as any;
      });

      if (launchError) {
        ctx.ui.notify(`Failed to launch hunk: ${launchError}`, "error");
      }
    },
  });
}
