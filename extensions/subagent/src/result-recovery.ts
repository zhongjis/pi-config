import type { AgentRecord } from "./types.js";
import { getAgentConversation } from "./agent-runner.js";

const TRANSCRIPT_SNIPPET_MAX_CHARS = 1200;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...(truncated)";
}

function getStatusSummary(status: AgentRecord["status"]): string {
  switch (status) {
    case "aborted":
      return "Agent hit the hard turn limit before producing a final answer.";
    case "steered":
      return "Agent wrapped up under turn pressure before producing a final answer.";
    case "stopped":
      return "Agent was stopped before producing a final answer.";
    case "error":
      return "Agent failed before producing a final answer.";
    case "completed":
      return "Agent completed without producing final text.";
    default:
      return `Agent ended with status \"${status}\" before producing a final answer.`;
  }
}

export function getRecoveredResultText(record: Pick<AgentRecord, "status" | "result" | "error" | "toolUses" | "outputFile" | "session">): string {
  const resultText = record.result?.trim();
  if (resultText) return resultText;

  const parts: string[] = [getStatusSummary(record.status)];

  if (record.error?.trim()) {
    parts.push(`Error: ${record.error.trim()}`);
  }

  if (record.toolUses > 0) {
    parts.push(`Tool uses before exit: ${record.toolUses}`);
  }

  const transcript = record.session ? getAgentConversation(record.session).trim() : "";
  if (transcript) {
    parts.push(`Last available transcript snippet:\n${truncate(transcript, TRANSCRIPT_SNIPPET_MAX_CHARS)}`);
  }

  if (record.outputFile) {
    parts.push(`Transcript file: ${record.outputFile}`);
  }

  return parts.join("\n\n");
}
