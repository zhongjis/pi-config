import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_RESULT_PREVIEW_CHARS } from "../constants.js";
import { createOutputFilePath } from "../output-file.js";
import { formatWorkflowNotification, type WorkflowTask, workflowResultText } from "./task.js";

/** Preserve model-facing completion text while recording the existing artifact write outcome. */
export function workflowCompletionText(ctx: ExtensionContext, task: WorkflowTask): string {
  const result = workflowResultText(task);
  // Short results inline in full; anything past the preview cap is written to an artifact and
  // linked from the notification via `<result-file>`, so the model never carries an unbounded body.
  if (result.length <= WORKFLOW_RESULT_PREVIEW_CHARS) return formatWorkflowNotification(task);
  try {
    const path = join(dirname(createOutputFilePath(ctx.cwd, task.id, ctx.sessionManager.getSessionId())), `${task.id}.workflow-result.txt`);
    writeFileSync(path, result, "utf-8");
    task.resultPath = path;
    // `task.resultPath` now drives the truncation marker and `<result-file>` element inside the XML.
    return formatWorkflowNotification(task);
  } catch (error) {
    const warning = `Full graph run result could not be saved: ${error instanceof Error ? error.message : String(error)}`;
    task.resultArtifactError = warning;
    if (ctx.hasUI) ctx.ui.notify(warning, "warning");
    else console.warn(`[pi-subagents] ${warning}`);
    // Write failed, so there is no `<result-file>`: keep the (still-capped) inline preview and
    // point at the expanded report, which retains the complete result.
    return `${formatWorkflowNotification(task)}\nWarning: ${warning}. Full output remains in the expanded graph run report.`;
  }
}
