/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */
import type { AgentSession } from "@mariozechner/pi-coding-agent";
/** Create the output file path, ensuring the directory exists.
 *  Mirrors Claude Code's layout: /tmp/{prefix}-{uid}/{encoded-cwd}/{sessionId}/tasks/{agentId}.output */
export declare function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string;
/** Write the initial user prompt entry. */
export declare function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void;
/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 */
export declare function streamToOutputFile(session: AgentSession, path: string, agentId: string, cwd: string): () => void;
