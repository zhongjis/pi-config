import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_TOOL_NAMES,
  computeActiveToolNames,
  createToolCeilingTool,
  DEFAULT_BUILTIN_TOOL_NAMES,
  extensionCanonicalName,
  extensionCanonicalNames,
  extensionIdsForPath,
  formatAccessRules,
  isBuiltinToolName,
  isToolReachable,
  isTrustedToolSource,
  parseAccessRules,
  PLAN_TOOL_NAMES,
  resolveExtensionAccess,
  resolveToolAccess,
  selectActiveToolNames,
  toolCandidates,
  type ExtensionCandidate,
  type ToolCandidate,
} from "../active-tools.js";
import { invalidFrontmatterFieldMessage, parseAgentFrontmatter } from "../agent-frontmatter.js";

const exposures: Record<string, string> = {
  direct_tool: "direct",
  model_tool: "model-only",
  code_tool: "codemode",
  deferred_tool: "deferred",
  hidden_tool: "hidden",
};
const available = ["read", "bash", ...Object.keys(exposures), "agent"];
const base = {
  availableToolNames: available,
  builtinToolNames: ["read"],
  builtinToolUniverse: DEFAULT_BUILTIN_TOOL_NAMES,
  extensions: true as const,
  exposureOf: (name: string) => exposures[name],
};

describe("computeActiveToolNames exposure", () => {
  it.each([undefined, ["*"], ["direct_*", "model_*", "code_*", "deferred_*", "hidden_*"]])("never auto-activates codemode/deferred/hidden tools (extensionTools %j)", (extensionTools) => {
    expect(computeActiveToolNames({ ...base, extensionTools })).toEqual(["read", "direct_tool", "model_tool"]);
  });

  it("keeps allowlisted codemode/deferred tools only when already active", () => {
    expect(computeActiveToolNames({
      ...base,
      extensionTools: ["code_tool", "deferred_tool", "hidden_tool"],
      currentActiveToolNames: ["code_tool", "deferred_tool", "hidden_tool"],
    })).toEqual(["read", "code_tool", "deferred_tool"]);
  });

  it("drops active tools the allowlist does not reach", () => {
    expect(computeActiveToolNames({
      ...base,
      extensionTools: ["direct_tool"],
      currentActiveToolNames: ["bash", "code_tool", "agent"],
    })).toEqual(["read", "direct_tool"]);
  });

  it("treats every tool as direct without exposureOf", () => {
    const { exposureOf: _exposureOf, ...legacy } = base;
    expect(computeActiveToolNames(legacy)).toEqual(["read", ...Object.keys(exposures)]);
  });
});

describe("isToolReachable", () => {
  const policy = { builtinToolNames: ["read"], builtinToolUniverse: DEFAULT_BUILTIN_TOOL_NAMES, extensions: true as const };

  it("ignores exposure and active state", () => {
    expect(isToolReachable({ ...policy, extensionTools: ["code_*"] }, "code_tool")).toBe(true);
    expect(isToolReachable({ ...policy, extensionTools: ["direct_tool"] }, "code_tool")).toBe(false);
    expect(isToolReachable(policy, "hidden_tool")).toBe(true);
  });

  it("applies built-in selection, nesting, and extension switches", () => {
    expect(isToolReachable(policy, "read")).toBe(true);
    expect(isToolReachable(policy, "bash")).toBe(false);
    expect(isToolReachable({ ...policy, extensionTools: ["agent"] }, "agent")).toBe(false);
    expect(isToolReachable({ ...policy, extensionTools: ["agent"], allowNesting: true }, "agent")).toBe(true);
    expect(isToolReachable({ ...policy, isolated: true }, "direct_tool")).toBe(false);
    expect(isToolReachable({ ...policy, extensions: false }, "direct_tool")).toBe(false);
    expect(isToolReachable({ ...policy, extensionTools: false }, "direct_tool")).toBe(false);
  });
});

// ─── BUILTIN_TOOL_NAMES / PLAN_TOOL_NAMES ────────────────────────────────

describe("isBuiltinToolName", () => {
  it("matches the copy of Pi's internal built-in tool list", () => {
    for (const name of BUILTIN_TOOL_NAMES) expect(isBuiltinToolName(name)).toBe(true);
    expect(isBuiltinToolName("powershell")).toBe(true);
    expect(isBuiltinToolName("codegraph_search")).toBe(false);
  });
});

// ─── parseAccessRules ────────────────────────────────────────────────────

describe("parseAccessRules", () => {
  it("omitted, empty, and [] value all mean no rules", () => {
    expect(parseAccessRules("tools", undefined)).toEqual({ rules: [], diagnostics: [] });
    expect(parseAccessRules("tools", null)).toEqual({ rules: [], diagnostics: [] });
    expect(parseAccessRules("tools", [])).toEqual({ rules: [], diagnostics: [] });
    expect(parseAccessRules("tools", "")).toEqual({ rules: [], diagnostics: [] });
  });

  it("parses a YAML list and a CSV string identically", () => {
    const list = parseAccessRules("tools", ["+@all", "-edit"]);
    const csv = parseAccessRules("tools", "+@all, -edit");
    expect(list).toEqual(csv);
    expect(list.rules).toEqual([{ sign: "+", selector: "@all" }, { sign: "-", selector: "edit" }]);
  });

  it("preserves rule order (sign and ordering are observable later during fold)", () => {
    const a = parseAccessRules("tools", "+@all, -edit");
    const b = parseAccessRules("tools", "-edit, +@all");
    expect(a.rules.map((r) => `${r.sign}${r.selector}`)).toEqual(["+@all", "-edit"]);
    expect(b.rules.map((r) => `${r.sign}${r.selector}`)).toEqual(["-edit", "+@all"]);
  });

  it("errors on an unsigned entry with a fix hint, and keeps the other valid entries", () => {
    const { rules, diagnostics } = parseAccessRules("tools", ["read", "+edit"]);
    expect(rules).toEqual([{ sign: "+", selector: "edit" }]);
    expect(diagnostics).toEqual([
      { severity: "error", message: 'unsigned entry "read": prefix + to grant or - to remove, e.g. "+read"' },
    ]);
  });

  it("errors on an empty selector or one containing whitespace/parentheses", () => {
    expect(parseAccessRules("tools", ["+"]).diagnostics[0].severity).toBe("error");
    expect(parseAccessRules("tools", ["+read write"]).diagnostics[0].severity).toBe("error");
    expect(parseAccessRules("tools", ["+read(1)"]).diagnostics[0].severity).toBe("error");
  });

  it("warns when the leading rule is a subtraction", () => {
    const { diagnostics } = parseAccessRules("tools", ["-edit", "+read"]);
    expect(diagnostics).toEqual([
      { severity: "warning", message: 'leading "-edit" removes nothing from the empty start.' },
    ]);
  });

  it("errors on boolean extensions with the +@all rewrite hint", () => {
    const { rules, diagnostics } = parseAccessRules("extensions", true);
    expect(rules).toEqual([]);
    expect(diagnostics).toEqual([
      { severity: "error", message: 'boolean extensions is obsolete; use "extensions: +@all" to load every extension or omit the field to load none.' },
    ]);
  });

  it("errors on a boolean tools value and on any other non-string, non-array value", () => {
    expect(parseAccessRules("tools", false).diagnostics[0].message).toMatch(/must be a list of signed rules/);
    expect(parseAccessRules("tools", 42).diagnostics[0].message).toMatch(/must be a list of signed rules/);
    expect(parseAccessRules("tools", { foo: "bar" }).diagnostics[0].message).toMatch(/must be a list of signed rules/);
  });

  it("errors when an array entry is not a string", () => {
    const { diagnostics } = parseAccessRules("tools", ["+read", 7]);
    expect(diagnostics[0].severity).toBe("error");
  });

  it("extensions: only @all and @builtin groups are allowed", () => {
    expect(parseAccessRules("extensions", ["+@all"]).diagnostics).toEqual([]);
    expect(parseAccessRules("extensions", ["+@builtin"]).diagnostics).toEqual([]);
    const { diagnostics } = parseAccessRules("extensions", ["+@codegraph"]);
    expect(diagnostics[0].message).toMatch(/unknown group/);
  });

  it("extensions: a bare 'all'/'builtin' is a reserved-word error", () => {
    const { diagnostics } = parseAccessRules("extensions", ["+all"]);
    expect(diagnostics[0].message).toBe('"all" is a reserved word; use "@all" instead.');
  });

  it("extensions: a path-like selector errors instead of resolving an id", () => {
    for (const bad of ["./foo.ts", "../foo.ts", "~/foo.ts", "/abs/foo.ts", "foo\\bar"]) {
      const { diagnostics } = parseAccessRules("extensions", [`+${bad}`]);
      expect(diagnostics[0].message).toMatch(/looks like a path/);
    }
  });

  it("extensions: lowercases the whole selector", () => {
    expect(parseAccessRules("extensions", ["+Pi-Web-Access"]).rules).toEqual([{ sign: "+", selector: "pi-web-access" }]);
  });

  it("tools: @read/@write/@package/@project/@user/@mcp:* are reserved for the future", () => {
    for (const reserved of ["@read", "@write", "@package", "@project", "@user", "@mcp:foo"]) {
      const { diagnostics } = parseAccessRules("tools", [`+${reserved}`]);
      expect(diagnostics[0].message).toMatch(/reserved/);
    }
  });

  it("tools: an @ selector with a glob, or a bare @, is an error", () => {
    expect(parseAccessRules("tools", ["+@foo*"]).diagnostics[0].message).toMatch(/cannot use a glob/);
    expect(parseAccessRules("tools", ["+@"]).diagnostics[0].message).toMatch(/not a valid selector/);
  });

  it("tools: lowercases only @ selectors, keeping name/glob case", () => {
    expect(parseAccessRules("tools", ["+@Codegraph", "+Read_File"]).rules).toEqual([
      { sign: "+", selector: "@codegraph" },
      { sign: "+", selector: "Read_File" },
    ]);
  });
});

describe("formatAccessRules", () => {
  it("joins rules as +sel, -sel", () => {
    expect(formatAccessRules([{ sign: "+", selector: "read" }, { sign: "-", selector: "edit" }])).toBe("+read, -edit");
  });

  it("returns an empty string for an empty list", () => {
    expect(formatAccessRules([])).toBe("");
  });
});

// ─── resolveExtensionAccess ──────────────────────────────────────────────

describe("resolveExtensionAccess", () => {
  const candidates: ExtensionCandidate[] = [
    { key: "/ext/alpha.ts", ids: ["alpha"] },
    { key: "/ext/beta/index.ts", ids: ["beta", "beta-pkg"] },
    { key: "builtin:codemode", ids: ["builtin:codemode"] },
    { key: "builtin:mcp", ids: ["builtin:mcp"] },
  ];

  it("+@all selects everything; -@builtin then drops the builtins", () => {
    const { selected, diagnostics } = resolveExtensionAccess(
      [{ sign: "+", selector: "@all" }, { sign: "-", selector: "@builtin" }],
      candidates,
    );
    expect(selected).toEqual(new Set(["/ext/alpha.ts", "/ext/beta/index.ts"]));
    expect(diagnostics).toEqual([]);
  });

  it("an id or glob selector with zero matches warns", () => {
    expect(resolveExtensionAccess([{ sign: "+", selector: "nope" }], candidates).diagnostics).toEqual([
      { severity: "warning", message: '"nope" matches no extension' },
    ]);
    expect(resolveExtensionAccess([{ sign: "+", selector: "nope-*" }], candidates).diagnostics).toEqual([
      { severity: "warning", message: '"nope-*" matches no extension' },
    ]);
  });

  it("a non-glob id matching more than one distinct key is ambiguous and matches nothing", () => {
    const dupCandidates: ExtensionCandidate[] = [
      { key: "/ext/a.ts", ids: ["dup"] },
      { key: "/ext/b.ts", ids: ["dup"] },
    ];
    const { selected, diagnostics } = resolveExtensionAccess([{ sign: "+", selector: "dup" }], dupCandidates);
    expect(selected.size).toBe(0);
    expect(diagnostics).toEqual([
      { severity: "error", message: '"dup" is ambiguous: matches /ext/a.ts, /ext/b.ts' },
    ]);
  });

  it("groups never warn even with no builtin extensions present", () => {
    const { diagnostics } = resolveExtensionAccess([{ sign: "+", selector: "@builtin" }], [
      { key: "/ext/alpha.ts", ids: ["alpha"] },
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("last matching rule wins across signs", () => {
    const rulesAllFirst = [{ sign: "+" as const, selector: "@all" }, { sign: "-" as const, selector: "alpha" }];
    const rulesEditFirst = [{ sign: "-" as const, selector: "alpha" }, { sign: "+" as const, selector: "@all" }];
    expect(resolveExtensionAccess(rulesAllFirst, candidates).selected.has("/ext/alpha.ts")).toBe(false);
    expect(resolveExtensionAccess(rulesEditFirst, candidates).selected.has("/ext/alpha.ts")).toBe(true);
  });
});

// ─── resolveToolAccess ────────────────────────────────────────────────────

describe("resolveToolAccess", () => {
  it("@builtin matches a built-in name by name, even when its source is an overriding extension", () => {
    const tools: ToolCandidate[] = [{ name: "bash", source: "/x/better-bash/index.ts", extensionIds: ["better-bash"] }];
    const { allowed, diagnostics } = resolveToolAccess([{ sign: "+", selector: "@builtin" }], tools);
    expect(allowed.has("bash")).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it("@<ext> excludes built-in names even when the extension id matches", () => {
    const tools: ToolCandidate[] = [
      { name: "bash", source: "/x/better-bash/index.ts", extensionIds: ["better-bash"] },
      { name: "better_bash_status", source: "/x/better-bash/index.ts", extensionIds: ["better-bash"] },
    ];
    const { allowed } = resolveToolAccess([{ sign: "+", selector: "@better-bash" }], tools);
    expect(allowed.has("bash")).toBe(false);
    expect(allowed.has("better_bash_status")).toBe(true);
  });

  it("@<ext> resolves via extensionIds and catches a late-registered extension tool", () => {
    const tools: ToolCandidate[] = [
      { name: "codegraph_search", source: "/x/codegraph/index.ts", extensionIds: ["codegraph"] },
      { name: "codegraph_impact", source: "/x/codegraph/index.ts", extensionIds: ["codegraph"] },
    ];
    const { allowed } = resolveToolAccess([{ sign: "+", selector: "@codegraph" }], tools);
    expect(allowed).toEqual(new Set(["codegraph_search", "codegraph_impact"]));
  });

  it("an ambiguous @<id> spanning two sources is an error and matches nothing", () => {
    const tools: ToolCandidate[] = [
      { name: "foo_a", source: "/x/a/index.ts", extensionIds: ["dup"] },
      { name: "foo_b", source: "/x/b/index.ts", extensionIds: ["dup"] },
    ];
    const { allowed, diagnostics } = resolveToolAccess([{ sign: "+", selector: "@dup" }], tools);
    expect(allowed.size).toBe(0);
    expect(diagnostics).toEqual([
      { severity: "error", message: '"@dup" is ambiguous: matches /x/a/index.ts, /x/b/index.ts' },
    ]);
  });

  it("zero-match warnings fire for @ext but never for tool names or globs", () => {
    const tools: ToolCandidate[] = [{ name: "read", source: undefined, extensionIds: [] }];
    expect(resolveToolAccess([{ sign: "+", selector: "@nope" }], tools).diagnostics).toEqual([
      { severity: "warning", message: '"@nope" matches no tool' },
    ]);
    expect(resolveToolAccess([{ sign: "+", selector: "no_such_tool" }], tools).diagnostics).toEqual([]);
    expect(resolveToolAccess([{ sign: "+", selector: "no_such_*" }], tools).diagnostics).toEqual([]);
  });

  it("errors when rules use @all/@builtin and an extension id collides with the reserved word", () => {
    const tools: ToolCandidate[] = [{ name: "all_tool", source: "/x/all/index.ts", extensionIds: ["all"] }];
    const { allowed, diagnostics } = resolveToolAccess([{ sign: "+", selector: "@all" }], tools);
    // the group keeps its meaning: @all still grants everything.
    expect(allowed.has("all_tool")).toBe(true);
    expect(diagnostics).toEqual([
      { severity: "error", message: 'extension id "all" collides with the reserved group word "@all"; the group keeps its meaning.' },
    ]);
  });

  it("folds @all, @builtin, -<id>, and name globs together", () => {
    const tools: ToolCandidate[] = [
      { name: "read", source: undefined, extensionIds: [] },
      { name: "edit", source: undefined, extensionIds: [] },
      { name: "foo_tool", source: "/x/foo/index.ts", extensionIds: ["foo"] },
      { name: "bar_tool", source: "/x/bar/index.ts", extensionIds: ["bar"] },
    ];
    const { allowed } = resolveToolAccess(
      [{ sign: "+", selector: "@all" }, { sign: "-", selector: "@foo" }, { sign: "-", selector: "bar_*" }],
      tools,
    );
    expect(allowed).toEqual(new Set(["read", "edit"]));
  });

  it("trusted sources are always allowed, overriding every gate and the rules", () => {
    const tools: ToolCandidate[] = [
      { name: "session_local_get", source: "<inline:session-local>", extensionIds: [] },
      { name: "structured_output", source: "<sdk:structured-output>", extensionIds: [] },
    ];
    const { allowed } = resolveToolAccess([], tools, { allowNesting: false, planTools: false });
    expect(allowed).toEqual(new Set(["session_local_get", "structured_output"]));
  });

  it("denies nested-subagent tools unless allowNesting is true", () => {
    const tools: ToolCandidate[] = [{ name: "agent", source: "/x/subagents/index.ts", extensionIds: ["subagents"] }];
    expect(resolveToolAccess([{ sign: "+", selector: "@all" }], tools).allowed.has("agent")).toBe(false);
    expect(resolveToolAccess([{ sign: "+", selector: "@all" }], tools, { allowNesting: true }).allowed.has("agent")).toBe(true);
  });

  it("goal tools are allowed only through the goal gate's allowed list", () => {
    const tools: ToolCandidate[] = [{ name: "goal_set", source: "/x/goal/index.ts", extensionIds: ["goal"] }];
    const denied = resolveToolAccess([{ sign: "+", selector: "@all" }], tools, { goalTools: { names: ["goal_set"], allowed: [] } });
    expect(denied.allowed.has("goal_set")).toBe(false);
    const permitted = resolveToolAccess([{ sign: "+", selector: "@all" }], tools, { goalTools: { names: ["goal_set"], allowed: ["goal_set"] } });
    expect(permitted.allowed.has("goal_set")).toBe(true);
  });

  it("plan tools are Fu Xi-only: granted when true, denied when false, untouched when undefined", () => {
    const tools: ToolCandidate[] = PLAN_TOOL_NAMES.map((name) => ({ name, source: "/x/modes/index.ts", extensionIds: ["modes"] }));
    expect(resolveToolAccess([], tools, { planTools: true }).allowed).toEqual(new Set(PLAN_TOOL_NAMES));
    expect(resolveToolAccess([{ sign: "+", selector: "@all" }], tools, { planTools: false }).allowed.size).toBe(0);
    expect(resolveToolAccess([{ sign: "+", selector: "@all" }], tools, {}).allowed).toEqual(new Set(PLAN_TOOL_NAMES));
  });
});

describe("isTrustedToolSource", () => {
  it("is true only for <inline:...> and <sdk:...> sources", () => {
    expect(isTrustedToolSource("<inline:foo>")).toBe(true);
    expect(isTrustedToolSource("<sdk:foo>")).toBe(true);
    expect(isTrustedToolSource("/x/foo/index.ts")).toBe(false);
    expect(isTrustedToolSource(undefined)).toBe(false);
  });
});

// ─── selectActiveToolNames ────────────────────────────────────────────────

describe("selectActiveToolNames", () => {
  const tools = [
    { name: "read", exposure: "direct" },
    { name: "model_tool", exposure: "model-only" },
    { name: "unknown_exposure" },
    { name: "code_tool", exposure: "codemode" },
    { name: "deferred_tool", exposure: "deferred" },
    { name: "hidden_tool", exposure: "hidden" },
    { name: "not_allowed", exposure: "direct" },
  ];
  const allowed = new Set(["read", "model_tool", "unknown_exposure", "code_tool", "deferred_tool", "hidden_tool"]);

  it("includes direct/model-only/unknown-exposure allowed tools, keeps codemode/deferred only when already active, and never includes hidden", () => {
    expect(selectActiveToolNames(tools, allowed, ["code_tool"])).toEqual([
      "read", "model_tool", "unknown_exposure", "code_tool",
    ]);
  });

  it("dedupes by name and preserves registry order", () => {
    const dup = [{ name: "read", exposure: "direct" }, { name: "read", exposure: "direct" }];
    expect(selectActiveToolNames(dup, new Set(["read"]), [])).toEqual(["read"]);
  });
});

// ─── createToolCeilingTool ────────────────────────────────────────────────

describe("createToolCeilingTool", () => {
  it("hides its own declaration and every declared tool the allowlist does not grant, calling the provider once", () => {
    const provider = vi.fn(() => new Set(["read"]));
    const ceiling = createToolCeilingTool("mode_tool_ceiling", provider);
    const loadout = {
      declared: [{ name: "mode_tool_ceiling" }, { name: "read" }, { name: "edit" }],
      callable: [],
      registered: [],
      getExposure: () => "direct" as const,
      getNamespace: () => undefined,
    };

    const changes = ceiling.prepareLoadout?.(loadout as any);

    expect(changes?.hiddenDeclarations).toEqual(["mode_tool_ceiling", "edit"]);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("is model-only and reports itself as internal when called", async () => {
    const ceiling = createToolCeilingTool("mode_tool_ceiling", () => new Set());
    expect(ceiling.exposure).toBe("model-only");
    const result = await ceiling.execute("call-1", {}, undefined, undefined, {} as any);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });
});

// ─── extension identity ────────────────────────────────────────────────────

describe("extensionCanonicalName", () => {
  it("strips .ts/.js from a single-file extension basename", () => {
    expect(extensionCanonicalName("/x/foo.ts")).toBe("foo");
    expect(extensionCanonicalName("/x/foo.js")).toBe("foo");
  });
  it("uses the parent directory name for index.{ts,js} extensions", () => {
    expect(extensionCanonicalName("/x/foo/index.ts")).toBe("foo");
    expect(extensionCanonicalName("/x/foo/index.js")).toBe("foo");
  });
  it("lowercases the result for case-insensitive matching", () => {
    expect(extensionCanonicalName("/x/MCP.ts")).toBe("mcp");
    expect(extensionCanonicalName("/x/MyExt.js")).toBe("myext");
    expect(extensionCanonicalName("/x/Foo/index.ts")).toBe("foo");
  });
});

describe("extensionCanonicalNames (#143 — package short name alias)", () => {
  const tmpDirs: string[] = [];
  function pkgDir(name: string, piExtensions: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "lib-active-tools-pkg-"));
    tmpDirs.push(dir);
    const manifest: Record<string, unknown> = { name };
    if (piExtensions !== undefined) manifest.pi = { extensions: piExtensions };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
    return dir;
  }
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("aliases a package-declared index.ts entry to the unscoped, lowercased package name", () => {
    const dir = pkgDir("@scope/Pi-Subagents", ["./src/index.ts"]);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src", "pi-subagents"]);
  });

  it("adds no alias for a loose file with no enclosing package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "lib-active-tools-loose-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "foo.ts"), "export default () => {};");
    expect(extensionCanonicalNames(join(dir, "foo.ts"))).toEqual(["foo"]);
  });

  it("adds no alias when the nearest manifest does not declare this entry", () => {
    const dir = pkgDir("@scope/other-ext", ["./src/other.ts"]);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src"]);
  });

  it("adds no alias when the nearest package.json has no pi manifest", () => {
    const dir = pkgDir("just-a-project", undefined);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src"]);
  });

  it("does not climb past a node_modules boundary into a consumer's manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "lib-active-tools-consumer-"));
    tmpDirs.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", pi: { extensions: ["./node_modules/inner-ext/index.ts"] } }),
    );
    const inner = join(root, "node_modules", "inner-ext");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "index.ts"), "export default () => {};");
    expect(extensionCanonicalNames(join(inner, "index.ts"))).toEqual(["inner-ext"]);
  });
});

describe("extensionIdsForPath", () => {
  it("a builtin: path gives its own lowercased value", () => {
    expect(extensionIdsForPath("builtin:Codemode")).toEqual(["builtin:codemode"]);
  });

  it("a trusted <inline:>/<sdk:> path gives no ids", () => {
    expect(extensionIdsForPath("<inline:foo>")).toEqual([]);
    expect(extensionIdsForPath("<sdk:foo>")).toEqual([]);
  });

  it("any other path resolves through extensionCanonicalNames, memoized per path", () => {
    const dir = mktempFixture();
    try {
      const path = join(dir, "foo.ts");
      writeFileSync(path, "export default () => {};");
      expect(extensionIdsForPath(path)).toEqual(["foo"]);
      // Second call hits the memo instead of reading disk again: removing the
      // file and the directory would make a fresh extensionCanonicalNames
      // call throw/walk further, but the cached result is still returned.
      rmSync(path);
      expect(extensionIdsForPath(path)).toEqual(["foo"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function mktempFixture(): string {
    return mkdtempSync(join(tmpdir(), "lib-active-tools-ids-"));
  }
});

describe("toolCandidates", () => {
  it("built-in names get no extension ids even when registered with a source path", () => {
    const candidates = toolCandidates([{ name: "bash", sourceInfo: { path: "/x/better-bash/index.ts" } }]);
    expect(candidates).toEqual([{ name: "bash", source: "/x/better-bash/index.ts", extensionIds: [] }]);
  });

  it("non-built-in tools resolve extension ids from sourceInfo.path, or none without a path", () => {
    const candidates = toolCandidates([
      { name: "foo_tool", sourceInfo: { path: "builtin:codemode" } },
      { name: "bar_tool" },
    ]);
    expect(candidates).toEqual([
      { name: "foo_tool", source: "builtin:codemode", extensionIds: ["builtin:codemode"] },
      { name: "bar_tool", source: undefined, extensionIds: [] },
    ]);
  });
});

// ─── agent-frontmatter parser: toolRules/extensionRules/diagnostics ───────

describe("parseAgentFrontmatter tools/extensions rules", () => {
  it("parses tools: and extensions: into rules and field-tagged diagnostics", () => {
    const parsed = parseAgentFrontmatter({ tools: ["+@all", "-edit"], extensions: ["+@all"] });
    expect(parsed.toolRules).toEqual([{ sign: "+", selector: "@all" }, { sign: "-", selector: "edit" }]);
    expect(parsed.extensionRules).toEqual([{ sign: "+", selector: "@all" }]);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("an omitted tools/extensions field parses to no rules and no diagnostics", () => {
    const parsed = parseAgentFrontmatter({});
    expect(parsed.toolRules).toEqual([]);
    expect(parsed.extensionRules).toEqual([]);
    expect(parsed.invalidFields).toEqual([]);
  });

  it("a tools: parse error adds 'tools' to invalidFields, tagged with field 'tools'", () => {
    const parsed = parseAgentFrontmatter({ tools: ["read"] });
    expect(parsed.invalidFields).toEqual(["tools"]);
    expect(parsed.diagnostics).toEqual([
      { field: "tools", severity: "error", message: 'unsigned entry "read": prefix + to grant or - to remove, e.g. "+read"' },
    ]);
  });

  it("TRANSITIONAL: an extensions: rule error is recorded but does not invalidate the definition", () => {
    const parsed = parseAgentFrontmatter({ extensions: true });
    expect(parsed.invalidFields).toEqual([]);
    expect(parsed.diagnostics[0]).toMatchObject({ field: "extensions", severity: "error" });
  });

  it("'tools' is no longer an obsolete field by itself", () => {
    expect(invalidFrontmatterFieldMessage("disallowed_tools")).toMatch(/invalid\/obsolete/);
    const parsed = parseAgentFrontmatter({ tools: ["+read"] });
    expect(parsed.invalidFields).toEqual([]);
  });
});
