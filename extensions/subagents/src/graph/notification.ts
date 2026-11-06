import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GRAPH_RUN_RESULT_PREVIEW_CHARS } from "../constants.js";
import { createOutputFilePath } from "../output-file.js";
import { formatGraphRunNotification, type GraphRunTask, graphRunReport, graphRunResultText } from "./task.js";

/**
 * Save Markdown reports regardless of length, and full results that exceed the preview cap.
 * Each artifact is attempted once; recorded success or failure prevents rewrites and repeat warnings.
 */
export function writeGraphResultArtifact(ctx: ExtensionContext, task: GraphRunTask): void {
  const report = graphRunReport(task);
  if (report !== undefined && task.reportPath === undefined && task.reportArtifactError === undefined) {
    try {
      const path = join(dirname(createOutputFilePath(ctx.cwd, task.id, ctx.sessionManager.getSessionId())), `${task.id}.report.md`);
      writeFileSync(path, report, "utf-8");
      task.reportPath = path;
    } catch (error) {
      const warning = `Graph run report could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      task.reportArtifactError = warning;
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
      else console.warn(`[pi-subagents] ${warning}`);
    }
  }
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
  writeGraphResultArtifact(ctx, task);
  const result = graphRunResultText(task);
  // Reports stay inline in full. Other content keeps the preview cap and artifact link.
  if (result.length <= GRAPH_RUN_RESULT_PREVIEW_CHARS) return formatGraphRunNotification(task);
  // `task.resultPath` drives the truncation marker and `<result-file>` element inside the XML.
  if (task.resultPath !== undefined) return formatGraphRunNotification(task);
  // Write failed, so there is no `<result-file>`: keep the (still-capped) inline preview and
  // point at the expanded report, which retains the complete result.
  const warning = task.resultArtifactError ?? "Full graph run result could not be saved";
  return `${formatGraphRunNotification(task)}\nWarning: ${warning}. Full output remains in the expanded graph run report.`;
}
