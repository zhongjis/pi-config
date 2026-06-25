import { formatTokens } from "../../lib/widget-style.js";

export interface LifetimeUsage {
  input: number;
  output: number;
  cacheWrite: number;
}

export function addUsage(into: LifetimeUsage, delta: { input: number; output: number; cacheWrite: number }): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
}

export function formatLifetimeTokens(usage: LifetimeUsage): string {
  return formatTokens(usage.input + usage.output + usage.cacheWrite);
}
