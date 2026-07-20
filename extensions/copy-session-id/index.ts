import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeClipboard } from "../lib/clipboard.js";

function formatSessionMetadata(
  sessionId: string,
  sessionLogPath?: string,
): string {
  return [
    `use pi-jsonl-logs skill to analyze the following session log based on user request`,
    `session-id: ${JSON.stringify(sessionId)}`,
    `session-log-path: ${sessionLogPath ? JSON.stringify(sessionLogPath) : "null"}`,
  ].join("\n");
}

function tryNotify(
  ctx: any,
  message: string,
  type: "success" | "error",
): boolean {
  try {
    ctx.ui.notify(message, type);
    return true;
  } catch {
    return false;
  }
}

export default function copySessionIdExtension(pi: ExtensionAPI): void {
  pi.registerCommand("session:copy-id", {
    description: "Copy current session ID and session log path to clipboard",
    handler: async (_args: string, ctx: any) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionLogPath = ctx.sessionManager.getSessionFile();
      const payload = formatSessionMetadata(sessionId, sessionLogPath);

      let backend: string;
      try {
        backend = await writeClipboard(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(payload);
        if (!tryNotify(ctx, `Clipboard copy failed: ${message}\n${payload}`, "error")) {
          console.error(`Clipboard copy failed: ${message}`);
        }
        return;
      }

      tryNotify(
        ctx,
        `Copied session metadata to clipboard via ${backend}`,
        "success",
      );
    },
  });
}
