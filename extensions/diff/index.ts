/**
 * Diff Extension
 *
 * /diff opens hunk (https://github.com/modem-dev/hunk) to review the current
 * git working-tree changes. Suspends pi's TUI, hands the terminal to hunk,
 * then resumes once hunk exits.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { isTui } from "../lib/mode.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Review git changes in hunk",
    handler: async (_args, ctx) => {
      if (!isTui(ctx)) {
        ctx.ui.notify("diff requires interactive (TUI) mode", "error");
        return;
      }

      // Bail early when there is nothing to review.
      const status = await pi.exec("git", ["status", "--porcelain"], {
        cwd: ctx.cwd,
      });
      if (status.code !== 0) {
        ctx.ui.notify(`git status failed: ${status.stderr}`, "error");
        return;
      }
      if (!status.stdout || !status.stdout.trim()) {
        ctx.ui.notify("No changes in working tree", "info");
        return;
      }

      // Suspend pi's TUI, hand the terminal to hunk, then resume.
      // Pattern mirrors extensions/modes/src/plan-approval.ts (refineInSystemEditor).
      let launchError: string | undefined;
      await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
        try {
          tui.stop();
          // Enter alternate screen so hunk output doesn't pollute scrollback.
          process.stdout.write("\x1b[?1049h");
          const result = spawnSync("hunk", ["diff"], {
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
