import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isTui } from "../../lib/mode.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

export async function runCodexReview(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  argv: string[],
): Promise<{ ok: boolean; review: string }> {
  return new Promise((resolve) => {
    const child = spawn("codex", argv, {
      cwd: ctx.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let activity = "";
    let frameIdx = 0;
    const startMs = Date.now();
    let ticker: ReturnType<typeof setInterval> | undefined;
    let off: (() => void) | undefined;

    if (isTui(ctx)) {
      ticker = setInterval(() => {
        const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
        frameIdx++;
        const elapsedSec = Math.floor((Date.now() - startMs) / 1000);
        ctx.ui.setWidget("codex-review", [
          `${frame} codex review · ${elapsedSec}s`,
          `  ${activity.slice(0, 100)}`,
        ]);
      }, 80);

      off = ctx.ui.onTerminalInput((data: string) => {
        if (data.includes("\x1b") || data.includes("\x03")) {
          child.kill("SIGTERM");
        }
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

    child.on("close", (code) => {
      const ok = code === 0;
      const review = ok
        ? stdoutBuf.trim()
        : stderrBuf.replace(ANSI_REGEX, "").replace(/\r/g, "").trim().slice(-2000) ||
          "Unknown error";
      try {
        resolve({ ok, review });
      } finally {
        if (ticker !== undefined) clearInterval(ticker);
        if (off !== undefined) off();
        if (isTui(ctx)) {
          ctx.ui.setWidget("codex-review", undefined);
          ctx.ui.setStatus("codex-review", undefined);
        }
      }
    });
  });
}
