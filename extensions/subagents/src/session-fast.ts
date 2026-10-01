import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FastPolicy } from "../../lib/fast.js";

/** Retain the runner-owned policy reference so fallback and resume stay observable. */
export const sessionFastPolicies = new WeakMap<AgentSession, FastPolicy>();

export function getSessionFast(session: AgentSession): boolean | undefined {
  return sessionFastPolicies.get(session)?.enabled;
}
