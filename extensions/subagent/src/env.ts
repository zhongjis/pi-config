/**
 * env.ts — Detect environment info (git, platform) for subagent system prompts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_GIT_TIMEOUT_MS } from "./constants.js";
import type { EnvInfo } from "./types.js";

export async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  let isGitRepo = false;
  let branch = "";

  try {
    const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: SUBAGENT_GIT_TIMEOUT_MS });
    isGitRepo = result.code === 0 && result.stdout.trim() === "true";
  } catch {
    // Not a git repo or git not installed
  }

  if (isGitRepo) {
    try {
      const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: SUBAGENT_GIT_TIMEOUT_MS });
      branch = result.code === 0 ? result.stdout.trim() : "unknown";
    } catch {
      branch = "unknown";
    }
  }

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}
