import type { AgentRecord } from "./types.js";
export declare function getRecoveredResultText(record: Pick<AgentRecord, "status" | "result" | "error" | "toolUses" | "outputFile" | "session">): string;
