/**
 * env.ts — Detect environment info (git, platform) for subagent system prompts.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { EnvInfo } from "./types.js";
export declare function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo>;
