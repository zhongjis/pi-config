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
const expectedSha = "60201be160749965b9bb4c3b2744e1bbee820dc5";
const expectedVersion = "4.19.1";

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
  "sisyphus/kimi-k3.md",
  "ultrawork/default.md",
  "ultrawork/gpt.md",
];

type ArchiveCheckResult = {
  ok: boolean;
  missing: string[];
  changed: string[];
  extra: string[];
};

type SyncModule = {
  FINAL_PROMPT_PATHS: string[];
  PINNED_SHA: string;
  PINNED_VERSION: string;
  checkFinalPrompts: (options: { generatedDir: string; targetDir: string }) => Promise<ArchiveCheckResult>;
  syncFinalPrompts: (options: {
    generatedDir?: string;
    targetDir: string;
    tempRoot?: string;
    generator?: (options: { outputDir: string; expectedSha: string; expectedVersion: string }) => Promise<void>;
  }) => Promise<{ ok: boolean; targetDir: string; written: string[] }>;
  [key: string]: unknown;
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
    version: options.version ?? expectedVersion,
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
const args = process.argv.slice(2);
appendFileSync(process.env.OMO_TEST_COMMAND_LOG, \`git \${args.join(" ")}\\n\`);
const sourceDir = args[0] === "init" ? args.at(-1) : args[args.indexOf("-C") + 1];
if (args[0] === "init") mkdirSync(sourceDir, { recursive: true });
if (args.includes("checkout")) {
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(new URL("package.json", \`file://\${sourceDir}/\`), JSON.stringify({ version: "${expectedVersion}" }));
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
  writeFileSync(join(outputDir, ".omo-final-prompts.json"), JSON.stringify({ sha: "${expectedSha}", version: "${expectedVersion}" }) + "\\n");
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
  it("exposes a root-runnable final-prompt-only module/CLI seam", async () => {
    expect(existsSync(scriptPath)).toBe(true);
    const sync = await loadModule();
    expect(sync).not.toHaveProperty("ULW_PLAN_PATHS");
    expect(sync).not.toHaveProperty("DEFAULT_ULW_PLAN_TARGET_DIR");
    expect(sync).not.toHaveProperty("checkOhMyOpenAgentArchive");
    expect(sync).not.toHaveProperty("syncOhMyOpenAgentArchive");
    expect(sync).not.toHaveProperty("generatePinnedOhMyOpenAgentArchive");
  });

  it("defines the canonical 45-path generated prompt matrix", async () => {
    const sync = await loadModule();
    expect(sync.PINNED_SHA).toBe(expectedSha);
    expect(sync.PINNED_VERSION).toBe(expectedVersion);
    expect(sync.FINAL_PROMPT_PATHS).toEqual(expectedMatrix);
    expect(sync.FINAL_PROMPT_PATHS).toHaveLength(45);
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
      "sisyphus-junior": 9,
      ultrawork: 2,
    });
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
      extra: ["atlas/extra.md"],
    });
    await expect(readFile(join(targetDir, "atlas/default.md"), "utf8")).resolves.toBe("local edit\n");
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

  it.runIf(existsSync("/dev/shm") && statSync("/dev/shm").dev !== statSync(tmpdir()).dev)(
    "sync keeps atomic replacement on the target filesystem",
    async () => {
      const sync = await loadModule();
      const generatedDir = join(root, "generated-cross-device");
      const targetDir = join(root, "target-cross-device");
      const crossDeviceTempRoot = await mkdtemp("/dev/shm/omo-final-prompts-test-");
      await writeGenerated(generatedDir, { prefix: "cross-device" });
      try {
        await sync.syncFinalPrompts({ generatedDir, targetDir, tempRoot: crossDeviceTempRoot });
        await expect(readFile(join(targetDir, "atlas/default.md"), "utf8")).resolves.toBe("cross-device:atlas/default.md\n");
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
        throw new Error("fake generator failed");
      },
    })).rejects.toThrow("fake generator failed");

    expect(await listTree(tempRoot)).toEqual([]);
    await expect(lstat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("CLI supports final-prompt-only fixture check and sync", async () => {
    const generatedDir = join(root, "generated");
    const targetDir = join(root, "target");
    await writeGenerated(generatedDir);

    await expect(execFileAsync(process.execPath, [
      scriptPath,
      "check",
      "--generated",
      generatedDir,
      "--target",
      targetDir,
      "--json",
    ], { cwd: repoRoot })).rejects.toMatchObject({ code: 1 });

    const syncRun = await execFileAsync(process.execPath, [
      scriptPath,
      "sync",
      "--generated",
      generatedDir,
      "--target",
      targetDir,
    ], { cwd: repoRoot });
    expect(syncRun.stderr).toBe("");
    expect(syncRun.stdout).toContain("synced 45 files");

    const checkRun = await execFileAsync(process.execPath, [
      scriptPath,
      "check",
      "--generated",
      generatedDir,
      "--target",
      targetDir,
      "--json",
    ], { cwd: repoRoot });
    expect(JSON.parse(checkRun.stdout)).toEqual({ ok: true, missing: [], changed: [], extra: [] });
  });

  it("CLI generates final prompts from one pinned upstream checkout by default", async () => {
    const targetDir = join(root, "target");
    const tempRoot = join(root, "tmp");
    const fakeBin = join(root, "bin");
    const commandLog = join(root, "commands.log");
    await writeFakeUpstreamCommands(fakeBin);

    const run = await execFileAsync(process.execPath, [
      scriptPath,
      "sync",
      "--target",
      targetDir,
      "--temp-root",
      tempRoot,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        OMO_TEST_COMMAND_LOG: commandLog,
        OMO_TEST_MATRIX: JSON.stringify(expectedMatrix),
      },
    });

    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("synced 45 files");
    expect(await listTree(targetDir)).toEqual(expectedMatrix);
    expect(await listTree(tempRoot)).toEqual([]);
    const commands = await readFile(commandLog, "utf8");
    expect(commands.match(/^git init/gm)).toHaveLength(1);
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
