import { spawn } from "node:child_process";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isTui } from "../../lib/mode.js";
import { formatDuration, headingIcon, SEPARATOR, spinnerGlyph, TREE } from "../../lib/widget-style.js";

type Theme = { fg(color: string, text: string): string };

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

export async function runCodexReview(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  argv: string[],
  cwd = ctx.cwd,
  widgetLabel = "codex review",
): Promise<{ ok: boolean; review: string }> {
  return new Promise((resolve) => {
    let resolved = false;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let off: (() => void) | undefined;

    const finish = (result: { ok: boolean; review: string }) => {
      if (resolved) return;
      resolved = true;
      try {
        resolve(result);
      } finally {
        if (ticker !== undefined) clearInterval(ticker);
        if (off !== undefined) off();
        if (isTui(ctx)) {
          ctx.ui.setWidget("codex-review", undefined);
          ctx.ui.setStatus("codex-review", undefined);
        }
      }
    };

    const child = spawn("codex", argv, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let activity = "";
    let frameIdx = 0;
    const startMs = Date.now();
    let tui: { requestRender(): void } | undefined;
    let widgetRegistered = false;

    const renderWidget = (t: { terminal: { columns: number } }, theme: Theme): string[] => {
      const truncate = (line: string) => truncateToWidth(line, t.terminal.columns);
      const elapsed = formatDuration(Date.now() - startMs);
      const heading = `${theme.fg("accent", headingIcon(true))} ${theme.fg("accent", widgetLabel)}${theme.fg("dim", SEPARATOR + elapsed)}`;
      const act = activity.split("\n").find((l) => l.trim())?.trim() || "working…";
      return [
        truncate(heading),
        truncate(`${theme.fg("dim", TREE.last)} ${theme.fg("accent", spinnerGlyph(frameIdx))} ${theme.fg("dim", act)}`),
      ];
    };

    if (isTui(ctx)) {
      ticker = setInterval(() => {
        frameIdx++;
        if (!widgetRegistered) {
          ctx.ui.setWidget(
            "codex-review",
            (t: any, theme: Theme) => {
              tui = t;
              return {
                render: () => renderWidget(t, theme),
                invalidate: () => {
                  widgetRegistered = false;
                  tui = undefined;
                },
              };
            },
            { placement: "aboveEditor" },
          );
          widgetRegistered = true;
        } else {
          tui?.requestRender();
        }
      }, 80);

      off = ctx.ui.onTerminalInput((data: string) => {
        if (data.includes("\x1b") || data.includes("\x03")) {
          child.kill("SIGTERM");
        }
        return undefined;
      });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf
        .split(/[\n\r]+/)
        .map((l) => l.replace(ANSI_REGEX, "").trim())
        .filter(Boolean);
      if (lines.length > 0) {
        activity = lines[lines.length - 1];
      }
    });

    child.on("error", (err) => {
      finish({ ok: false, review: err instanceof Error ? err.message : String(err) });
    });

    child.on("close", (code) => {
      const ok = code === 0;
      const review = ok
        ? stdoutBuf.trim()
        : stderrBuf.replace(ANSI_REGEX, "").replace(/\r/g, "").trim().slice(-2000) ||
          "Unknown error";
      finish({ ok, review });
    });
  });
}
