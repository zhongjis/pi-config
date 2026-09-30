import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GRAPH_RUN_RESULT_PREVIEW_CHARS } from "../constants.js";
import { createOutputFilePath } from "../output-file.js";
import { formatGraphRunNotification, type GraphRunTask, graphRunResultText } from "./task.js";

/**
 * Write the full result beside the session task artifacts when it exceeds the preview cap.
 * No rewrite once `resultPath` is set; a recorded save failure is not retried, so the warning notifies once.
 */
export function writeGraphResultArtifact(ctx: ExtensionContext, task: GraphRunTask): void {
  if (task.resultPath !== undefined || task.resultArtifactError !== undefined) return;
  const result = graphRunResultText(task);
  // Short results stay inline; anything past the preview cap is written and linked via `<result-file>`.
  if (result.length <= GRAPH_RUN_RESULT_PREVIEW_CHARS) return;
  try {
    const path = join(dirname(createOutputFilePath(ctx.cwd, task.id, ctx.sessionManager.getSessionId())), `${task.id}.graph-result.txt`);
    writeFileSync(path, result, "utf-8");
    task.resultPath = path;
  } catch (error) {
    const warning = `Full graph run result could not be saved: ${error instanceof Error ? error.message : String(error)}`;
    task.resultArtifactError = warning;
    if (ctx.hasUI) ctx.ui.notify(warning, "warning");
    else console.warn(`[pi-subagents] ${warning}`);
  }
}

/** Model-facing completion text. Reuses {@link writeGraphResultArtifact}. */
export function graphRunCompletionText(ctx: ExtensionContext, task: GraphRunTask): string {
  const result = graphRunResultText(task);
  // Short results inline in full; anything past the preview cap is written to an artifact and
  // linked from the notification via `<result-file>`, so the model never carries an unbounded body.
  if (result.length <= GRAPH_RUN_RESULT_PREVIEW_CHARS) return formatGraphRunNotification(task);
  writeGraphResultArtifact(ctx, task);
  // `task.resultPath` drives the truncation marker and `<result-file>` element inside the XML.
  if (task.resultPath !== undefined) return formatGraphRunNotification(task);
  // Write failed, so there is no `<result-file>`: keep the (still-capped) inline preview and
  // point at the expanded report, which retains the complete result.
  const warning = task.resultArtifactError ?? "Full graph run result could not be saved";
  return `${formatGraphRunNotification(task)}\nWarning: ${warning}. Full output remains in the expanded graph run report.`;
}
