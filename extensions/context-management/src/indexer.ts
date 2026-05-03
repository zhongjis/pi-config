import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CapturedBatch, IndexEntryData, ToolCallRecord } from "./types.js";
import { CUSTOM_TYPE_INDEX } from "./types.js";

export class ToolCallIndexer {
  private index = new Map<string, ToolCallRecord>();

  /**
   * Rebuilds the in-memory index from session history by scanning all
   * custom entries with customType === CUSTOM_TYPE_INDEX.
   */
  reconstructFromSession(ctx: ExtensionContext): void {
    this.index.clear();
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (
        entry.type === "custom" &&
        (entry as any).customType === CUSTOM_TYPE_INDEX
      ) {
        const data = (entry as any).data as IndexEntryData;
        if (data && Array.isArray(data.toolCalls)) {
          for (const toolCall of data.toolCalls) {
            this.index.set(toolCall.toolCallId, toolCall);
          }
        }
      }
    }
  }

  /**
   * Returns true if the given toolCallId has been summarized (exists in index).
   */
  isSummarized(toolCallId: string): boolean {
    return this.index.has(toolCallId);
  }

  /**
   * Returns the full runtime index map.
   */
  getIndex(): Map<string, ToolCallRecord> {
    return this.index;
  }

  /**
   * Look up a single record by toolCallId (used by query tool).
   */
  getRecord(toolCallId: string): ToolCallRecord | undefined {
    return this.index.get(toolCallId);
  }

  /**
   * Looks up multiple tool call records by ID. Skips any IDs not found.
   */
  lookupToolCalls(toolCallIds: string[]): ToolCallRecord[] {
    const results: ToolCallRecord[] = [];
    for (const id of toolCallIds) {
      const record = this.index.get(id);
      if (record !== undefined) {
        results.push(record);
      }
    }
    return results;
  }

  /**
   * Adds all tool calls from a captured batch to the runtime index and
   * persists an IndexEntryData entry to the session via pi.appendEntry.
   */
  addBatch(batch: CapturedBatch, pi: ExtensionAPI): void {
    const records: ToolCallRecord[] = [];

    for (const tc of batch.toolCalls) {
      const record: ToolCallRecord = {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        resultText: tc.resultText,
        isError: tc.isError,
        turnIndex: batch.turnIndex,
        timestamp: batch.timestamp,
      };
      this.index.set(record.toolCallId, record);
      records.push(record);
    }

    pi.appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);
  }
}
