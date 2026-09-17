import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createOutputFilePath } from "../output-file.js";
import { formatWorkflowNotification, type WorkflowTask, workflowResultText } from "./task.js";

/** Preserve model-facing completion text while recording the existing artifact write outcome. */
export function workflowCompletionText(ctx: ExtensionContext, task: WorkflowTask): string {
  const notification = formatWorkflowNotification(task);
  const result = workflowResultText(task);
  if (result.length <= 4000) return notification;
  try {
    const path = join(dirname(createOutputFilePath(ctx.cwd, task.id, ctx.sessionManager.getSessionId())), `${task.id}.workflow-result.txt`);
    writeFileSync(path, result, "utf-8");
    task.resultPath = path;
    return `${notification}\nFull workflow result: ${path}`;
  } catch (error) {
    const warning = `Full workflow result could not be saved: ${error instanceof Error ? error.message : String(error)}`;
    task.resultArtifactError = warning;
    if (ctx.hasUI) ctx.ui.notify(warning, "warning");
    else console.warn(`[pi-subagents] ${warning}`);
    return `${notification}\nWarning: ${warning}. Full output remains in the expanded workflow report.`;
  }
}
