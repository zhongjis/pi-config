import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initLib } from "../lib/index.js";
import { isTui } from "../lib/mode.js";
import { preflight } from "./src/preflight.js";
import { parseTarget, resolveCodexArgs } from "./src/detect.js";
import { runCodexReview } from "./src/run.js";

interface CommandArgumentCompletion {
  value: string;
  label: string;
}

const COMPLETIONS: CommandArgumentCompletion[] = [
  { value: "uncommitted", label: "uncommitted — review working tree changes" },
  { value: "base", label: "base [ref] — review vs upstream or origin HEAD" },
  { value: "commit", label: "commit [sha] — review a specific commit (default: HEAD)" },
];

export default function secondOpinion(pi: ExtensionAPI) {
  initLib(pi);

  pi.registerCommand("codex:review", {
    description: "Run codex review on git changes and post the result",
    getArgumentCompletions: (prefix: string): CommandArgumentCompletion[] | null => {
      const p = prefix.trim().toLowerCase();
      const filtered = COMPLETIONS.filter((c) => c.value.startsWith(p));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: any) => {
      const ok = await preflight(pi, ctx);
      if (!ok) return;

      const target = parseTarget(args);

      const git = async (gitArgs: string[], cwd: string): Promise<string | null> => {
        const r = await pi.exec("git", gitArgs, { cwd });
        return r.code === 0 ? (r.stdout || "").trim() : null;
      };

      let argv: string[];
      try {
        argv = await resolveCodexArgs(target, git, ctx.cwd);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }

      if (isTui(ctx)) {
        ctx.ui.setStatus("codex-review", "Running codex review…");
      }

      const result = await runCodexReview(pi, ctx, argv);

      if (result.ok) {
        pi.sendMessage({
          customType: "second-opinion",
          content: result.review,
          display: true,
        });
        ctx.ui.notify("Codex review complete", "info");
      } else {
        ctx.ui.notify(`Codex review failed: ${result.review.slice(0, 200)}`, "error");
      }
    },
  });
}
