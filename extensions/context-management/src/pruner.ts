import type { ToolCallIndexer } from "./indexer.js";

/**
 * Filters the `context` event message array.
 * Removes ToolResultMessage entries where toolCallId is in the index.
 * Keeps ALL other messages including AssistantMessages with tool-call blocks.
 */
export function pruneMessages(messages: any[], indexer: ToolCallIndexer): any[] {
  return messages.filter((msg) => {
    // Only remove toolResult messages that have been summarized
    if (msg.role === "toolResult" && indexer.isSummarized(msg.toolCallId)) {
      return false;
    }
    return true;
  });
}
