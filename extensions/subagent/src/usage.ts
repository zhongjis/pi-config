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
  const total = usage.input + usage.output + usage.cacheWrite;
  if (total >= 1_000_000) return `󰾆 ${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `󰾆 ${(total / 1_000).toFixed(1)}k`;
  return `󰾆 ${total}`;
}
