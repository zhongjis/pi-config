import { existsSync, statSync } from "node:fs";
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/sync-oh-my-openagent-final-prompts.mjs");
const scriptUrl = pathToFileURL(scriptPath).href;
const expectedSha = "14083b89f1cbf4680be13493a6c4afd67c957e8a";
const expectedVersion = "4.19.0";

const expectedMatrix = [
  "atlas/default.md",
  "atlas/gemini.md",
  "atlas/glm.md",
  "atlas/gpt.md",
  "atlas/kimi-k2-7.md",
  "atlas/kimi-k3.md",
  "atlas/kimi.md",
  "atlas/opus-4-7.md",
  "explore/default.md",
  "hephaestus/gpt-5-4.md",
  "hephaestus/gpt-5-5.md",
  "hephaestus/gpt-5-6.md",
  "hephaestus/gpt.md",
  "librarian/default.md",
  "metis/default.md",
  "metis/kimi-k2-7.md",
  "momus/default.md",
  "momus/gpt-5-6.md",
  "momus/gpt.md",
  "multimodal-looker/default.md",
  "oracle/default.md",
  "oracle/gpt-5-5.md",
  "oracle/gpt.md",
  "prometheus/default.md",
  "sisyphus-junior/default.md",
  "sisyphus-junior/gemini.md",
  "sisyphus-junior/glm-5-2.md",
  "sisyphus-junior/gpt-5-4.md",
  "sisyphus-junior/gpt-5-5.md",
  "sisyphus-junior/gpt.md",
  "sisyphus-junior/kimi-k2-7.md",
  "sisyphus-junior/kimi-k2.md",
  "sisyphus-junior/kimi-k3.md",
  "sisyphus/claude-fable-5.md",
  "sisyphus/claude-opus-4-7.md",
  "sisyphus/claude-opus-4-8.md",
  "sisyphus/fallback.md",
  "sisyphus/glm-5-2.md",
  "sisyphus/gpt-5-4.md",
  "sisyphus/gpt-5-5.md",
  "sisyphus/kimi-k2-6.md",
  "sisyphus/kimi-k2-7.md",
  "sisyphus/kimi-k3.md"
];

const expectedUlwPlanPaths = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/full-workflow.md",
  "references/intent-clear.md",
  "references/intent-unclear.md",
  "scripts/scaffold-plan.mjs"
];

type ArchiveCheckResult = {
  ok: boolean;
  missing: string[];
  changed: string[];
  extra: string[];
};

type SyncModule = {
  FINAL_PROMPT_PATHS: string[];
  ULW_PLAN_PATHS: string[];
  DEFAULT_ULW_PLAN_TARGET_DIR: string;
  PINNED_SHA: string;
  PINNED_VERSION: string;
  checkFinalPrompts: (options: { generatedDir: string; targetDir: string }) => Promise<ArchiveCheckResult>;
  syncFinalPrompts: (options: {
    generatedDir?: string;
    targetDir: string;
    tempRoot?: string;
    generator?: (options: { outputDir: string; expectedSha: string; expectedVersion: string }) => Promise<void>;
  }) => Promise<{ ok: boolean; targetDir: string; written: string[] }>;
  checkOhMyOpenAgentArchive: (options: {
    generatedDir?: string;
    skillSourceDir?: string;
    targetDir: string;
    skillTargetDir: string;
    tempRoot?: string;
  }) => Promise<{ ok: boolean; finalPrompts: ArchiveCheckResult; ulwPlan: ArchiveCheckResult }>;
  syncOhMyOpenAgentArchive: (options: {
    generatedDir?: string;
    skillSourceDir?: string;
    targetDir: string;
    skillTargetDir: string;
    tempRoot?: string;
  }) => Promise<{ ok: boolean; targetDir: string; skillTargetDir: string; written: { finalPrompts: string[]; ulwPlan: string[] } }>;
};

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omo-final-prompts-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function loadModule(): Promise<SyncModule> {
  return await import(`${scriptUrl}?t=${Date.now()}`) as SyncModule;
}

async function writeGenerated(dir: string, options: { sha?: string; version?: string; prefix?: string } = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".omo-final-prompts.json"), `${JSON.stringify({
    sha: options.sha ?? expectedSha,
    version: options.version ?? expectedVersion
  }, null, 2)}\n`);
  for (const path of expectedMatrix) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${options.prefix ?? "generated"}:${path}\n`);
  }
}

async function copyGeneratedToTarget(generatedDir: string, targetDir: string) {
  for (const path of expectedMatrix) {
    const source = join(generatedDir, path);
    const dest = join(targetDir, path);
    await mkdir(dirname(dest), { recursive: true });
    await cp(source, dest);
  }
}

async function writeSkillSource(dir: string, options: { prefix?: string; omit?: string[] } = {}) {
  await mkdir(dir, { recursive: true });
  for (const path of expectedUlwPlanPaths) {
    if (options.omit?.includes(path)) continue;
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${options.prefix ?? "skill"}:${path}\n`);
  }
}

async function copySkillToTarget(skillSourceDir: string, targetDir: string) {
  for (const path of expectedUlwPlanPaths) {
    const source = join(skillSourceDir, path);
    const dest = join(targetDir, path);
    await mkdir(dirname(dest), { recursive: true });
    await cp(source, dest);
  }
}

async function listTree(dir: string): Promise<string[]> {
  async function walk(current: string, prefix = ""): Promise<string[]> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    const paths = await Promise.all(entries.map(async (entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) return await walk(absolute, relative);
      return [relative];
    }));
    return paths.flat();
  }
  return (await walk(dir)).sort();
}

async function writeFakeUpstreamCommands(binDir: string) {
  await mkdir(binDir, { recursive: true });
  const gitPath = join(binDir, "git");
  const bunPath = join(binDir, "bun");
  await writeFile(gitPath, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.OMO_TEST_COMMAND_LOG, \`git \${args.join(" ")}\\n\`);
const sourceDir = args[0] === "init" ? args.at(-1) : args[args.indexOf("-C") + 1];
if (args[0] === "init") mkdirSync(sourceDir, { recursive: true });
if (args.includes("checkout")) {
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ version: "${expectedVersion}" }));
  const skillRoot = join(sourceDir, "packages/shared-skills/skills/ulw-plan");
  for (const path of JSON.parse(process.env.OMO_TEST_ULW_PLAN_PATHS)) {
    const file = join(skillRoot, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, \`upstream-skill:\${path}\\n\`);
  }
}
if (args.includes("rev-parse")) process.stdout.write("${expectedSha}\\n");
`);
  await writeFile(bunPath, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.OMO_TEST_COMMAND_LOG, \`bun \${args.join(" ")}\\n\`);
if (args[0] === "run") {
  const outputDir = args[args.indexOf("--output") + 1];
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, ".omo-final-prompts.json"), JSON.stringify({
    sha: "${expectedSha}",
    version: "${expectedVersion}"
  }) + "\\n");
  for (const path of JSON.parse(process.env.OMO_TEST_MATRIX)) {
    const file = join(outputDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, \`generated:\${path}\\n\`);
  }
}
`);
  await Promise.all([chmod(gitPath, 0o755), chmod(bunPath, 0o755)]);
}

describe("Oh My OpenAgent final-prompt sync contract", () => {
  it("exposes a root-runnable module/CLI seam", () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("defines the canonical 43-path matrix for 11 agents", async () => {
    const sync = await loadModule();
    expect(sync.PINNED_SHA).toBe(expectedSha);
    expect(sync.PINNED_VERSION).toBe(expectedVersion);
    expect(sync.FINAL_PROMPT_PATHS).toEqual(expectedMatrix);
    expect(sync.FINAL_PROMPT_PATHS).toHaveLength(43);
    expect(countByAgent(sync.FINAL_PROMPT_PATHS)).toEqual({
      atlas: 8,
      explore: 1,
      hephaestus: 4,
      librarian: 1,
      metis: 2,
      momus: 3,
      "multimodal-looker": 1,
      oracle: 3,
      prometheus: 1,
      sisyphus: 10,
      "sisyphus-junior": 9
    });
  });

  it("defines the canonical six-file ulw-plan skill snapshot", async () => {
    const sync = await loadModule();
    expect(sync.ULW_PLAN_PATHS).toEqual(expectedUlwPlanPaths);
    expect(sync.ULW_PLAN_PATHS).toHaveLength(6);
    expect(sync.DEFAULT_ULW_PLAN_TARGET_DIR).toBe("docs/references/oh-my-openagent/skills/ulw-plan");
  });

  it("check reports missing, changed, and extra files without writing", async () => {
    const sync = await loadModule();
    const generatedDir = join(root, "generated");
    const targetDir = join(root, "target");
    await writeGenerated(generatedDir);
    await copyGeneratedToTarget(generatedDir, targetDir);
    await rm(join(targetDir, "oracle/gpt.md"));
    await writeFile(join(targetDir, "atlas/default.md"), "local edit\n");
    await writeFile(join(targetDir, "atlas/extra.md"), "extra\n");

    const result = await sync.checkFinalPrompts({ generatedDir, targetDir });

    expect(result).toEqual({
      ok: false,
      missing: ["oracle/gpt.md"],
      changed: ["atlas/default.md"],
      extra: ["atlas/extra.md"]
    });
    await expect(readFile(join(targetDir, "atlas/default.md"), "utf8")).resolves.toBe("local edit\n");
    await expect(lstat(join(targetDir, "oracle/gpt.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("archive check reports missing, changed, and extra ulw-plan files without writing", async () => {
    const sync = await loadModule();
    const generatedDir = join(root, "generated");
    const skillSourceDir = join(root, "skill-source");
    const targetDir = join(root, "target");
    const skillTargetDir = join(root, "skill-target");
    await writeGenerated(generatedDir);
    await copyGeneratedToTarget(generatedDir, targetDir);
    await writeSkillSource(skillSourceDir);
    await copySkillToTarget(skillSourceDir, skillTargetDir);
    await rm(join(skillTargetDir, "references/intent-clear.md"));
    await writeFile(join(skillTargetDir, "SKILL.md"), "local edit\n");
    await writeFile(join(skillTargetDir, "references/extra.md"), "extra\n");

    const result = await sync.checkOhMyOpenAgentArchive({ generatedDir, skillSourceDir, targetDir, skillTargetDir });

    expect(result).toEqual({
      ok: false,
      finalPrompts: { ok: true, missing: [], changed: [], extra: [] },
      ulwPlan: {
        ok: false,
        missing: ["references/intent-clear.md"],
        changed: ["SKILL.md"],
        extra: ["references/extra.md"]
      }
    });
    await expect(readFile(join(skillTargetDir, "SKILL.md"), "utf8")).resolves.toBe("local edit\n");
    await expect(lstat(join(skillTargetDir, "references/intent-clear.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sync replaces the target from staged generated content", async () => {
    const sync = await loadModule();
    const generatedDir = join(root, "generated");
    const targetDir = join(root, "target");
    await writeGenerated(generatedDir, { prefix: "v1" });
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "stale.md"), "stale\n");

    const result = await sync.syncFinalPrompts({ generatedDir, targetDir, tempRoot: join(root, "tmp") });

    expect(result).toEqual({ ok: true, targetDir, written: expectedMatrix });
    expect(await listTree(targetDir)).toEqual(expectedMatrix);
    await expect(readFile(join(targetDir, "sisyphus/fallback.md"), "utf8")).resolves.toBe("v1:sisyphus/fallback.md\n");
  });

  it("archive sync replaces stale prompts and ulw-plan skill bytes after validating both sets", async () => {
    const sync = await loadModule();
    const generatedDir = join(root, "generated");
    const skillSourceDir = join(root, "skill-source");
    const targetDir = join(root, "target");
    const skillTargetDir = join(root, "skill-target");
    await writeGenerated(generatedDir, { prefix: "archive" });
    await writeSkillSource(skillSourceDir, { prefix: "archive-skill" });
    await mkdir(targetDir, { recursive: true });
    await mkdir(skillTargetDir, { recursive: true });
    await writeFile(join(targetDir, "stale.md"), "stale prompt\n");
    await writeFile(join(skillTargetDir, "stale.md"), "stale skill\n");

    const result = await sync.syncOhMyOpenAgentArchive({
      generatedDir,
      skillSourceDir,
      targetDir,
      skillTargetDir,
      tempRoot: join(root, "tmp")
    });

    expect(result).toEqual({
      ok: true,
      targetDir,
      skillTargetDir,
      written: { finalPrompts: expectedMatrix, ulwPlan: expectedUlwPlanPaths }
    });
    expect(await listTree(targetDir)).toEqual(expectedMatrix);
    expect(await listTree(skillTargetDir)).toEqual(expectedUlwPlanPaths);
    await expect(readFile(join(targetDir, "atlas/default.md"), "utf8")).resolves.toBe("archive:atlas/default.md\n");
    await expect(readFile(join(skillTargetDir, "scripts/scaffold-plan.mjs"), "utf8"))
      .resolves.toBe("archive-skill:scripts/scaffold-plan.mjs\n");
  });

  it.runIf(existsSync("/dev/shm") && statSync("/dev/shm").dev !== statSync(tmpdir()).dev)(
    "sync keeps atomic replacement on the target filesystem",
    async () => {
      const sync = await loadModule();
      const generatedDir = join(root, "generated-cross-device");
      const targetDir = join(root, "target-cross-device");
      const crossDeviceTempRoot = await mkdtemp("/dev/shm/omo-final-prompts-test-");
      await writeGenerated(generatedDir, { prefix: "cross-device" });

      try {
        const result = await sync.syncFinalPrompts({ generatedDir, targetDir, tempRoot: crossDeviceTempRoot });

        expect(result.ok).toBe(true);
        await expect(readFile(join(targetDir, "atlas/default.md"), "utf8"))
          .resolves.toBe("cross-device:atlas/default.md\n");
      } finally {
        await rm(crossDeviceTempRoot, { recursive: true, force: true });
      }
    },
  );

  it("sync rejects a symlink target before any outside write", async () => {
    const sync = await loadModule();
    const generatedDir = join(root, "generated");
    const outsideDir = join(root, "outside");
    const targetDir = join(root, "target-link");
    await writeGenerated(generatedDir);
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "keep.md"), "keep\n");
    await symlink(outsideDir, targetDir, "dir");

    await expect(sync.syncFinalPrompts({ generatedDir, targetDir, tempRoot: join(root, "tmp") }))
      .rejects.toThrow("target must not be a symlink");
    expect(await listTree(outsideDir)).toEqual(["keep.md"]);
    await expect(readFile(join(outsideDir, "keep.md"), "utf8")).resolves.toBe("keep\n");
  });

  it("archive sync rejects a symlink skill target before replacing prompts", async () => {
    const sync = await loadModule();
    const generatedDir = join(root, "generated");
    const skillSourceDir = join(root, "skill-source");
    const targetDir = join(root, "target");
    const outsideDir = join(root, "outside-skill");
    const skillTargetDir = join(root, "skill-target-link");
    await writeGenerated(generatedDir, { prefix: "next" });
    await writeSkillSource(skillSourceDir);
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "sentinel.md"), "do not replace\n");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "keep.md"), "keep\n");
    await symlink(outsideDir, skillTargetDir, "dir");

    await expect(sync.syncOhMyOpenAgentArchive({
      generatedDir,
      skillSourceDir,
      targetDir,
      skillTargetDir,
      tempRoot: join(root, "tmp")
    })).rejects.toThrow("target must not be a symlink");
    expect(await listTree(targetDir)).toEqual(["sentinel.md"]);
    expect(await listTree(outsideDir)).toEqual(["keep.md"]);
  });

  it("sync rejects SHA/version mismatch before replacement", async () => {
    const sync = await loadModule();
    const generatedDir = join(root, "generated");
    const targetDir = join(root, "target");
    await writeGenerated(generatedDir, { sha: "bad", version: "0.0.0" });
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "sentinel.md"), "do not replace\n");

    await expect(sync.syncFinalPrompts({ generatedDir, targetDir, tempRoot: join(root, "tmp") }))
      .rejects.toThrow("generated metadata mismatch");
    expect(await listTree(targetDir)).toEqual(["sentinel.md"]);
    await expect(readFile(join(targetDir, "sentinel.md"), "utf8")).resolves.toBe("do not replace\n");
  });

  it("cleans temp dir after generator failure", async () => {
    const sync = await loadModule();
    const tempRoot = join(root, "tmp");
    const targetDir = join(root, "target");

    await expect(sync.syncFinalPrompts({
      targetDir,
      tempRoot,
      generator: async ({ outputDir }) => {
        await mkdir(outputDir, { recursive: true });
        await writeFile(join(outputDir, "partial.md"), "partial\n");
        throw new Error("fake generator failed");
      }
    })).rejects.toThrow("fake generator failed");

    expect(await listTree(tempRoot)).toEqual([]);
    await expect(lstat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("archive sync cleans temp dir after skill validation failure", async () => {
    const sync = await loadModule();
    const generatedDir = join(root, "generated");
    const skillSourceDir = join(root, "skill-source");
    const tempRoot = join(root, "tmp");
    const targetDir = join(root, "target");
    const skillTargetDir = join(root, "skill-target");
    await writeGenerated(generatedDir);
    await writeSkillSource(skillSourceDir, { omit: ["scripts/scaffold-plan.mjs"] });

    await expect(sync.syncOhMyOpenAgentArchive({ generatedDir, skillSourceDir, targetDir, skillTargetDir, tempRoot }))
      .rejects.toThrow("ulw-plan source file missing: scripts/scaffold-plan.mjs");

    expect(await listTree(tempRoot)).toEqual([]);
    await expect(lstat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(skillTargetDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("CLI supports combined fixture check and sync", async () => {
    const generatedDir = join(root, "generated");
    const skillSourceDir = join(root, "skill-source");
    const targetDir = join(root, "target");
    const skillTargetDir = join(root, "skill-target");
    await writeGenerated(generatedDir);
    await writeSkillSource(skillSourceDir);

    await expect(execFileAsync(process.execPath, [
      scriptPath,
      "check",
      "--generated",
      generatedDir,
      "--skill-source",
      skillSourceDir,
      "--target",
      targetDir,
      "--skill-target",
      skillTargetDir,
      "--json"
    ], { cwd: repoRoot })).rejects.toMatchObject({ code: 1 });

    await expect(execFileAsync(process.execPath, [
      scriptPath,
      "sync",
      "--generated",
      generatedDir,
      "--target",
      targetDir
    ], { cwd: repoRoot })).rejects.toMatchObject({ stderr: expect.stringContaining("--generated and --skill-source are required together") });

    const syncRun = await execFileAsync(process.execPath, [
      scriptPath,
      "sync",
      "--generated",
      generatedDir,
      "--skill-source",
      skillSourceDir,
      "--target",
      targetDir,
      "--skill-target",
      skillTargetDir
    ], { cwd: repoRoot });
    expect(syncRun.stderr).toBe("");
    expect(syncRun.stdout).toContain("synced 49 files");

    const checkRun = await execFileAsync(process.execPath, [
      scriptPath,
      "check",
      "--generated",
      generatedDir,
      "--skill-source",
      skillSourceDir,
      "--target",
      targetDir,
      "--skill-target",
      skillTargetDir,
      "--json"
    ], { cwd: repoRoot });
    expect(JSON.parse(checkRun.stdout)).toEqual({
      ok: true,
      finalPrompts: { ok: true, missing: [], changed: [], extra: [] },
      ulwPlan: { ok: true, missing: [], changed: [], extra: [] }
    });
  });

  it("CLI generates combined archive from one pinned upstream checkout by default", async () => {
    const targetDir = join(root, "target");
    const skillTargetDir = join(root, "skill-target");
    const tempRoot = join(root, "tmp");
    const fakeBin = join(root, "bin");
    const commandLog = join(root, "commands.log");
    await writeFakeUpstreamCommands(fakeBin);

    const run = await execFileAsync(process.execPath, [
      scriptPath,
      "sync",
      "--target",
      targetDir,
      "--skill-target",
      skillTargetDir,
      "--temp-root",
      tempRoot
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        OMO_TEST_COMMAND_LOG: commandLog,
        OMO_TEST_MATRIX: JSON.stringify(expectedMatrix),
        OMO_TEST_ULW_PLAN_PATHS: JSON.stringify(expectedUlwPlanPaths)
      }
    });

    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("synced 49 files");
    expect(await listTree(targetDir)).toEqual(expectedMatrix);
    expect(await listTree(skillTargetDir)).toEqual(expectedUlwPlanPaths);
    await expect(readFile(join(skillTargetDir, "SKILL.md"), "utf8")).resolves.toBe("upstream-skill:SKILL.md\n");
    expect(await listTree(tempRoot)).toEqual([]);
    const commands = await readFile(commandLog, "utf8");
    expect(commands.match(/^git init/gm)).toHaveLength(1);
    expect(commands).toContain(`git -C `);
    expect(commands).toContain(`fetch --depth 1 origin ${expectedSha}`);
    expect(commands).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(commands).toContain("bun run");
    expect(commands).toContain("--output");
  });
});

function countByAgent(paths: string[]) {
  return paths.reduce<Record<string, number>>((counts, path) => {
    const agent = path.split("/")[0];
    counts[agent] = (counts[agent] ?? 0) + 1;
    return counts;
  }, {});
}
