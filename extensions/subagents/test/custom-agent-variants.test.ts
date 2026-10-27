import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCustomAgentsWithDiagnostics } from "../src/custom-agents.js";

let root: string;
let locations: string[];

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-variants-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "global"));
  locations = [join(root, ".pi", "agents"), join(root, ".agents", "agents"), join(root, "global", "agents")];
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("directory agent definitions", () => {
  it.each([".pi", ".agents", "global"])("loads directory definitions and variants from location %s", (location) => {
    const directory = join(root, location, "agents", "worker");
    write(join(directory, "default.md"), "---\ntools: +read\n---\n DEFAULT_BODY \n");
    write(join(directory, "gpt.md"), " GPT_BODY \n");
    write(join(directory, "gemini.md"), " GEMINI_BODY \n");
    write(join(directory, "AGENTS.md"), "CONTEXT_BODY");
    write(join(directory, "notes.md"), "NOTES_BODY");
    write(join(directory, "nested", "default.md"), "NESTED_BODY");
    write(join(root, location, "agents", "variant-only", "gpt.md"), "ORPHAN_BODY");

    const result = loadCustomAgentsWithDiagnostics(root);

    expect([...result.agents.keys()]).toEqual(["worker"]);
    expect(result.agents.get("worker")).toMatchObject({
      systemPrompt: "DEFAULT_BODY", promptVariants: { gpt: "GPT_BODY", gemini: "GEMINI_BODY" },
      toolRules: [{ sign: "+", selector: "read" }], source: location === "global" ? "global" : "project",
    });
    expect(result.diagnostics).toEqual([]);
  });

  it.each([0, 1, 2, 3, 4, 5])("selects first valid candidate at priority %s and warns for every skipped definition", (validIndex) => {
    const candidates = locations.flatMap(location => [join(location, "worker", "default.md"), join(location, "worker.md")]);
    candidates.forEach((path, index) => write(path, `---\ntools: ${index < validIndex ? "read" : "+read"}\n---\nBODY_${index}`));

    const result = loadCustomAgentsWithDiagnostics(root);

    expect(result.agents.get("worker")?.systemPrompt).toBe(`BODY_${validIndex}`);
    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === "error").map(diagnostic => diagnostic.file)).toEqual(candidates.slice(0, validIndex));
    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === "warning")).toEqual(candidates.slice(0, validIndex).map(file => ({
      file, agentName: "worker", severity: "warning", message: `invalid definition; using ${candidates[validIndex]}`,
    })));
  });

  it("falls back from an unreadable default candidate to a flat definition", () => {
    const directory = join(root, ".pi", "agents", "worker");
    mkdirSync(join(directory, "default.md"), { recursive: true });
    const flat = write(join(root, ".pi", "agents", "worker.md"), "FLAT_BODY");

    const result = loadCustomAgentsWithDiagnostics(root);

    expect(result.agents.get("worker")?.systemPrompt).toBe("FLAT_BODY");
    expect(result.diagnostics).toMatchObject([
      { file: join(directory, "default.md"), field: "definition", severity: "error", message: expect.stringContaining("EISDIR") },
      { file: join(directory, "default.md"), severity: "warning", message: `invalid definition; using ${flat}` },
    ]);
  });

  it("treats a non-directory discovery root as absent", () => {
    mkdirSync(join(root, ".pi"));
    writeFileSync(join(root, ".pi", "agents"), "NOT_A_DIRECTORY");

    expect(loadCustomAgentsWithDiagnostics(root)).toEqual({ agents: new Map(), diagnostics: [] });
  });

  it("propagates discovery errors other than absent roots", () => {
    mkdirSync(join(root, ".pi"));
    symlinkSync("agents", join(root, ".pi", "agents"));

    expect(() => loadCustomAgentsWithDiagnostics(root)).toThrow(/ELOOP/);
  });

  it("keeps field errors and reports unavailable when every candidate is invalid", () => {
    write(join(root, ".pi", "agents", "worker", "default.md"), "---\ntools: read\n---\nDIRECTORY_BODY");
    write(join(root, "global", "agents", "worker.md"), "---\nextensions: false\n---\nGLOBAL_BODY");

    const result = loadCustomAgentsWithDiagnostics(root);

    expect(result.agents.has("worker")).toBe(false);
    expect(result.diagnostics.map(({ field, severity }) => ({ field, severity }))).toEqual([
      { field: "tools", severity: "error" }, { field: "extensions", severity: "error" }, { field: undefined, severity: "warning" },
    ]);
    expect(result.diagnostics.at(-1)).toEqual({ agentName: "worker", severity: "warning", message: "no valid definition; agent unavailable" });
  });
});
