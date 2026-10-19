/**
 * work-notes.ts — Per-agent work notes in the shared Agent-tree `local://` root.
 *
 * A writing subagent keeps `local://notes/<agentId>.md` current while it works;
 * the parent reads it mid-run, on resume, and after completion. Notes are
 * self-reported context, not verification evidence.
 */

import { existsSync } from "node:fs";
import type { AgentRecord } from "./types.js";

/** Notes path relative to the Agent-tree `local://` root. */
export function workNotesRelativePath(agentId: string): string {
  return `notes/${agentId}.md`;
}

/** System prompt section for an agent that owns a work-notes file. */
export function workNotesSection(agentId: string): string {
  return `<work_notes>
Your work-notes file: local://${workNotesRelativePath(agentId)}. You are its only writer; your parent reads it while you run, on resume, and after you finish.
You MUST create it with \`write\` after your first milestone and keep it current with \`edit\` after each later one: what you changed, commands run with exit status, findings and gotchas, and the current resume anchor. It MUST exist before your final answer, however small the task.
Keep entries short and factual. Your final answer still carries the complete report.
</work_notes>`;
}

/** The agent's `local://` notes URI, only once the file exists. */
export function workNotesUri(record: Pick<AgentRecord, "id" | "notesFile">): string | undefined {
  return record.notesFile && existsSync(record.notesFile) ? `local://${workNotesRelativePath(record.id)}` : undefined;
}

/** Model-visible pointer appended to agent results. */
export function workNotesSuffix(record: Pick<AgentRecord, "id" | "notesFile">): string {
  const notes = workNotesUri(record);
  return notes ? `\n\nWork notes: ${notes}` : "";
}
