import { type AccessRule, resolveToolAccess, type ToolAccessGates, toolCandidates } from "./active-tools.js";

/** Pi's `MCP_SERVERS_SECTION` prompt section key, not exported from Pi's package entry. */
export const MCP_SERVERS_SECTION = "mcp_servers";

/** Whether `tools:` rules deny every tool of an MCP namespace (`mcp__<server>`). */
export function isMcpNamespaceFullyDenied(toolRules: readonly AccessRule[], gates: ToolAccessGates, namespace: string): boolean {
  const prefix = `${namespace}__`;
  const probe = `${prefix}<probe>`;
  const candidates = toolCandidates([{ name: probe, sourceInfo: { path: "builtin:mcp" } }]);
  if (resolveToolAccess(toolRules, candidates, gates).allowed.has(probe)) return false;
  return !toolRules.some(({ sign, selector }) => {
    if (sign !== "+" || selector.startsWith("@")) return false;
    const star = selector.indexOf("*");
    if (star < 0) return selector.startsWith(prefix);
    const literal = selector.slice(0, star);
    return literal.startsWith(prefix) || prefix.startsWith(literal);
  });
}

/** Namespaces Pi lists in the `mcp_servers` section (`- mcp__<server> (…`). */
export function listedMcpNamespaces(section: string): string[] {
  return section.split("\n").flatMap((line) => /^- (mcp__\S+) \(/.exec(line)?.[1] ?? []);
}

/**
 * ponytail: Pi's MCP extension lists every enabled configured server in
 * `mcp_servers`, so drop the fully denied ones. Removable once Pi lists the
 * section from the allowed tools at startup (earendil-works/pi#10635).
 */
export function dropDeniedMcpServers(sections: Record<string, string>, deniedNamespaces: readonly string[]): void {
  const section = sections[MCP_SERVERS_SECTION];
  if (section === undefined || deniedNamespaces.length === 0) return;
  const deniedLines = deniedNamespaces.map((namespace) => `- ${namespace} (`);
  const lines = section.split("\n").filter((line) => !deniedLines.some((prefix) => line.startsWith(prefix)));
  if (lines.some((line) => line.startsWith("- mcp__"))) sections[MCP_SERVERS_SECTION] = lines.join("\n");
  else delete sections[MCP_SERVERS_SECTION];
}
