#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_REPOSITORY = "https://github.com/code-yeongyu/oh-my-openagent";
export const PINNED_SHA = "14083b89f1cbf4680be13493a6c4afd67c957e8a";
export const PINNED_VERSION = "4.19.0";
export const DEFAULT_TARGET_DIR = "docs/references/oh-my-openagent/final-prompts";
export const DEFAULT_ULW_PLAN_TARGET_DIR = "docs/references/oh-my-openagent/skills/ulw-plan";
export const MANIFEST_FILE = ".omo-final-prompts.json";

const scriptPath = fileURLToPath(import.meta.url);
const exporterPath = join(dirname(scriptPath), "export-oh-my-openagent-final-prompts.ts");
const activeChildren = new Set();
const activeCleanups = new Set();

export const FINAL_PROMPT_PATHS = Object.freeze([
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
  ]);

export const ULW_PLAN_PATHS = Object.freeze([
  "SKILL.md",
  "agents/openai.yaml",
  "references/full-workflow.md",
  "references/intent-clear.md",
  "references/intent-unclear.md",
  "scripts/scaffold-plan.mjs"
]);

const expectedFinalPromptPathSet = new Set(FINAL_PROMPT_PATHS);
const expectedUlwPlanPathSet = new Set(ULW_PLAN_PATHS);

export async function checkFinalPrompts({
  generatedDir,
  targetDir = DEFAULT_TARGET_DIR,
  tempRoot,
  generator
  } = {}) {
  if (generatedDir) {
    const generated = resolveRequiredDir(generatedDir, "generatedDir");
    await validateGeneratedDir(generated);
    return await compareFinalPrompts(generated, resolve(targetDir));
  }

  const tempParent = resolve(tempRoot ?? tmpdir());
  await mkdir(tempParent, { recursive: true });
  const workDir = await mkdtemp(join(tempParent, "omo-final-prompts-check-"));
  const cleanup = trackCleanup(() => rm(workDir, { recursive: true, force: true }));
  const generated = join(workDir, "generated");
  try {
    await generateFinalPrompts(generator, generated, workDir);
    await validateGeneratedDir(generated);
    return await compareFinalPrompts(generated, resolve(targetDir));
  } finally {
    await cleanup();
  }
}

async function compareFinalPrompts(generated, target) {
  return await compareExpectedFiles(generated, target, FINAL_PROMPT_PATHS, expectedFinalPromptPathSet);
}

export async function syncFinalPrompts({ generatedDir, targetDir = DEFAULT_TARGET_DIR, tempRoot, generator } = {}) {
  const target = resolve(targetDir);
  await assertTargetIsSafe(target);

  const tempParent = resolve(tempRoot ?? tmpdir());
  await mkdir(tempParent, { recursive: true });
  const workDir = await mkdtemp(join(tempParent, "omo-final-prompts-sync-"));
  const ownedGeneratedDir = join(workDir, "generated");
  const generated = generatedDir ? resolve(generatedDir) : ownedGeneratedDir;
  let replacement;
  let finished = false;
  const cleanup = trackCleanup(async () => {
    if (!finished && replacement) await replacement.rollback();
    if (replacement) await replacement.cleanup();
    await rm(workDir, { recursive: true, force: true });
  });

  try {
    if (!generatedDir) await generateFinalPrompts(generator, generated, workDir);
    else if (generator) {
      await generator({ outputDir: generated, expectedSha: PINNED_SHA, expectedVersion: PINNED_VERSION });
    }

    await validateGeneratedDir(generated);
    replacement = await prepareDirectoryReplacement({
      sourceRoot: generated,
      target,
      paths: FINAL_PROMPT_PATHS,
      stagePrefix: ".final-prompts-stage-"
    });
    await replacement.commit();
    finished = true;
    return { ok: true, targetDir, written: [...FINAL_PROMPT_PATHS] };
  } finally {
    await cleanup();
  }
}

export async function checkOhMyOpenAgentArchive({
  generatedDir,
  skillSourceDir,
  targetDir = DEFAULT_TARGET_DIR,
  skillTargetDir = DEFAULT_ULW_PLAN_TARGET_DIR,
  tempRoot
  } = {}) {
  ensureFixtureOptions(generatedDir, skillSourceDir);
  if (generatedDir) {
    const generated = resolveRequiredDir(generatedDir, "generatedDir");
    const skillSource = resolveRequiredDir(skillSourceDir, "skillSourceDir");
    await validateGeneratedDir(generated);
    await validateSkillSourceDir(skillSource);
    return combineArchiveChecks(
      await compareFinalPrompts(generated, resolve(targetDir)),
      await compareUlwPlanSkill(skillSource, resolve(skillTargetDir))
    );
  }

  const tempParent = resolve(tempRoot ?? tmpdir());
  await mkdir(tempParent, { recursive: true });
  const workDir = await mkdtemp(join(tempParent, "omo-archive-check-"));
  const cleanup = trackCleanup(() => rm(workDir, { recursive: true, force: true }));
  const generated = join(workDir, "generated");
  const skillSource = join(workDir, "ulw-plan");
  try {
    await generatePinnedOhMyOpenAgentArchive({ promptsDir: generated, skillDir: skillSource, tempRoot: workDir });
    await validateGeneratedDir(generated);
    await validateSkillSourceDir(skillSource);
    return combineArchiveChecks(
      await compareFinalPrompts(generated, resolve(targetDir)),
      await compareUlwPlanSkill(skillSource, resolve(skillTargetDir))
    );
  } finally {
    await cleanup();
  }
}

export async function syncOhMyOpenAgentArchive({
  generatedDir,
  skillSourceDir,
  targetDir = DEFAULT_TARGET_DIR,
  skillTargetDir = DEFAULT_ULW_PLAN_TARGET_DIR,
  tempRoot
  } = {}) {
  ensureFixtureOptions(generatedDir, skillSourceDir);
  const target = resolve(targetDir);
  const skillTarget = resolve(skillTargetDir);
  await assertTargetIsSafe(target);
  await assertTargetIsSafe(skillTarget);

  const tempParent = resolve(tempRoot ?? tmpdir());
  await mkdir(tempParent, { recursive: true });
  const workDir = await mkdtemp(join(tempParent, "omo-archive-sync-"));
  const generated = generatedDir ? resolve(generatedDir) : join(workDir, "generated");
  const skillSource = skillSourceDir ? resolve(skillSourceDir) : join(workDir, "ulw-plan");
  const replacements = [];
  let finished = false;
  const cleanup = trackCleanup(async () => {
    if (!finished) {
      for (const replacement of [...replacements].reverse()) await replacement.rollback();
    }
    for (const replacement of replacements) await replacement.cleanup();
    await rm(workDir, { recursive: true, force: true });
  });

  try {
    if (!generatedDir) {
      await generatePinnedOhMyOpenAgentArchive({ promptsDir: generated, skillDir: skillSource, tempRoot: workDir });
    }

    await validateGeneratedDir(generated);
    await validateSkillSourceDir(skillSource);

    replacements.push(await prepareDirectoryReplacement({
      sourceRoot: generated,
      target,
      paths: FINAL_PROMPT_PATHS,
      stagePrefix: ".final-prompts-stage-"
    }));
    replacements.push(await prepareDirectoryReplacement({
      sourceRoot: skillSource,
      target: skillTarget,
      paths: ULW_PLAN_PATHS,
      stagePrefix: ".ulw-plan-stage-"
    }));

    for (const replacement of replacements) await replacement.commit();
    finished = true;
    return {
      ok: true,
      targetDir,
      skillTargetDir,
      written: { finalPrompts: [...FINAL_PROMPT_PATHS], ulwPlan: [...ULW_PLAN_PATHS] }
    };
  } finally {
    await cleanup();
  }
}

function combineArchiveChecks(finalPrompts, ulwPlan) {
  return { ok: finalPrompts.ok && ulwPlan.ok, finalPrompts, ulwPlan };
}

function ensureFixtureOptions(generatedDir, skillSourceDir) {
  if (Boolean(generatedDir) !== Boolean(skillSourceDir)) {
    throw new Error("--generated and --skill-source are required together");
  }
}

async function compareUlwPlanSkill(skillSource, target) {
  return await compareExpectedFiles(skillSource, target, ULW_PLAN_PATHS, expectedUlwPlanPathSet);
}

async function compareExpectedFiles(sourceRoot, target, paths, expectedPathSet) {
  const missing = [];
  const changed = [];
  for (const path of paths) {
    const source = safeJoin(sourceRoot, path);
    const destination = safeJoin(target, path);
    const destinationStat = await lstat(destination).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!destinationStat) {
      missing.push(path);
      continue;
    }
    if (!destinationStat.isFile()) {
      changed.push(path);
      continue;
    }
    const [sourceBody, destinationBody] = await Promise.all([
      readFile(source),
      readFile(destination)
    ]);
    if (!sourceBody.equals(destinationBody)) changed.push(path);
  }

  const extra = (await listFiles(target)).filter((path) => !expectedPathSet.has(path)).sort();
  return { ok: missing.length === 0 && changed.length === 0 && extra.length === 0, missing, changed, extra };
}

async function generateFinalPrompts(generator, outputDir, tempRoot) {
  if (generator) {
    await generator({ outputDir, expectedSha: PINNED_SHA, expectedVersion: PINNED_VERSION });
    return;
  }
  await generatePinnedFinalPrompts({ outputDir, tempRoot });
}

export async function generatePinnedFinalPrompts({ outputDir, tempRoot, commandRunner = runCommand } = {}) {
  if (!outputDir) throw new Error("outputDir is required");
  await withPinnedCheckout(tempRoot, commandRunner, async (sourceDir) => {
    await runPromptExporter(sourceDir, outputDir, commandRunner);
  });
}

export async function generatePinnedOhMyOpenAgentArchive({ promptsDir, skillDir, tempRoot, commandRunner = runCommand } = {}) {
  if (!promptsDir) throw new Error("promptsDir is required");
  if (!skillDir) throw new Error("skillDir is required");
  await withPinnedCheckout(tempRoot, commandRunner, async (sourceDir) => {
    await runPromptExporter(sourceDir, promptsDir, commandRunner);
    await copyUlwPlanSkillFromCheckout(sourceDir, skillDir);
  });
}

async function withPinnedCheckout(tempRoot, commandRunner, callback) {
  const tempParent = resolve(tempRoot ?? tmpdir());
  await mkdir(tempParent, { recursive: true });
  const workDir = await mkdtemp(join(tempParent, "omo-upstream-"));
  const sourceDir = join(workDir, "source");
  const cleanup = trackCleanup(() => rm(workDir, { recursive: true, force: true }));

  try {
    await commandRunner("git", ["init", "-q", sourceDir]);
    await commandRunner("git", ["-C", sourceDir, "remote", "add", "origin", PINNED_REPOSITORY]);
    await commandRunner("git", ["-C", sourceDir, "fetch", "--depth", "1", "origin", PINNED_SHA]);
    await commandRunner("git", ["-C", sourceDir, "checkout", "--detach", "FETCH_HEAD"]);
    const revision = await commandRunner("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
    if (revision.stdout.trim() !== PINNED_SHA) {
      throw new Error(`upstream checkout mismatch: expected ${PINNED_SHA}, got ${revision.stdout.trim() || "empty revision"}`);
    }

    const packageJson = JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8"));
    if (packageJson.version !== PINNED_VERSION) {
      throw new Error(`upstream package version mismatch: expected ${PINNED_VERSION}, got ${packageJson.version}`);
    }
    await callback(sourceDir);
  } finally {
    await cleanup();
  }
}

async function runPromptExporter(sourceDir, outputDir, commandRunner) {
  const exporterStat = await lstat(exporterPath);
  if (!exporterStat.isFile()) throw new Error("prompt exporter must be a regular file");

  await commandRunner("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: sourceDir });
  await commandRunner("bun", [
    "run",
    exporterPath,
    "--source",
    sourceDir,
    "--output",
    resolve(outputDir),
    "--sha",
    PINNED_SHA,
    "--version",
    PINNED_VERSION
  ], { cwd: sourceDir });
}

async function copyUlwPlanSkillFromCheckout(sourceDir, skillDir) {
  const sourceRoot = join(sourceDir, "packages/shared-skills/skills/ulw-plan");
  await validateSkillSourceDir(sourceRoot);
  await mkdir(skillDir, { recursive: true });
  for (const path of ULW_PLAN_PATHS) {
    await copyExpectedFile(sourceRoot, skillDir, path);
  }
}

async function validateGeneratedDir(generatedDir) {
  const manifestPath = safeJoin(generatedDir, MANIFEST_FILE);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`generated metadata unreadable: ${error.message}`);
  }
  if (manifest.sha !== PINNED_SHA || manifest.version !== PINNED_VERSION) {
    throw new Error(`generated metadata mismatch: expected ${PINNED_SHA} / ${PINNED_VERSION}`);
  }

  for (const path of FINAL_PROMPT_PATHS) {
    const file = safeJoin(generatedDir, path);
    const stat = await lstat(file).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) throw new Error(`generated file missing: ${path}`);
    if (!stat.isFile()) throw new Error(`generated file must be a regular file: ${path}`);
  }
}

async function validateSkillSourceDir(skillSourceDir) {
  for (const path of ULW_PLAN_PATHS) {
    const file = safeJoin(skillSourceDir, path);
    const stat = await lstat(file).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) throw new Error(`ulw-plan source file missing: ${path}`);
    if (!stat.isFile()) throw new Error(`ulw-plan source file must be a regular file: ${path}`);
  }
  const extra = (await listFiles(skillSourceDir)).filter((path) => !expectedUlwPlanPathSet.has(path)).sort();
  if (extra.length > 0) throw new Error(`ulw-plan source unexpected file: ${extra.join(", ")}`);
}

async function prepareDirectoryReplacement({ sourceRoot, target, paths, stagePrefix }) {
  const targetParent = dirname(target);
  await mkdir(targetParent, { recursive: true });
  const stageRoot = await mkdtemp(join(targetParent, stagePrefix));
  const staging = join(stageRoot, "next");
  const previous = join(stageRoot, "previous");
  let movedPrevious = false;
  let committed = false;

  try {
    await mkdir(staging, { recursive: true });
    for (const path of paths) {
      await copyExpectedFile(sourceRoot, staging, path);
    }
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    async commit() {
      const targetExists = await pathExists(target);
      if (targetExists) {
        await rename(target, previous);
        movedPrevious = true;
      }
      try {
        await rename(staging, target);
        committed = true;
      } catch (error) {
        if (movedPrevious) await rename(previous, target).catch(() => {});
        movedPrevious = false;
        throw error;
      }
    },
    async rollback() {
      if (committed) {
        await rm(target, { recursive: true, force: true }).catch(() => {});
        if (movedPrevious && await pathExists(previous)) await rename(previous, target).catch(() => {});
        movedPrevious = false;
        committed = false;
        return;
      }
      if (movedPrevious && !(await pathExists(target)) && await pathExists(previous)) {
        await rename(previous, target).catch(() => {});
        movedPrevious = false;
      }
    },
    async cleanup() {
      await rm(stageRoot, { recursive: true, force: true });
    }
  };
}

async function copyExpectedFile(sourceRoot, targetRoot, path) {
  const source = safeJoin(sourceRoot, path);
  const destination = safeJoin(targetRoot, path);
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile()) throw new Error(`generated file must be a regular file: ${path}`);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: true, errorOnExist: false });
}

async function assertTargetIsSafe(target) {
  const stat = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error("target must not be a symlink");
  if (!stat.isDirectory()) throw new Error("target must be a directory");
}

function resolveRequiredDir(path, name) {
  if (!path) throw new Error(`${name} is required`);
  return resolve(path);
}

function safeJoin(root, path) {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`unsafe relative path: ${path}`);
  }
  const base = resolve(root);
  const joined = resolve(base, path);
  if (joined !== base && !joined.startsWith(`${base}${sep}`)) {
    throw new Error(`path escapes root: ${path}`);
  }
  return joined;
}

async function listFiles(root) {
  async function walk(current, prefix = "") {
    const entries = await readdir(current, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const files = [];
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) files.push(...await walk(absolute, path));
      else files.push(path);
    }
    return files;
  }
  return await walk(root);
}

async function pathExists(path) {
  return await lstat(path).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

function trackCleanup(action) {
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= action();
    return cleanupPromise;
  };
  activeCleanups.add(cleanup);
  return async () => {
    activeCleanups.delete(cleanup);
    await cleanup();
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      activeChildren.delete(child);
      reject(error);
    });
    child.on("close", (code, signal) => {
      activeChildren.delete(child);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})${detail ? `: ${detail}` : ""}`));
    });
  });
}

function installSignalCleanup() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      for (const child of activeChildren) child.kill(signal);
      const cleanups = [...activeCleanups].reverse();
      await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--generated") {
      options.generatedDir = rest[++index];
      continue;
    }
    if (arg === "--skill-source") {
      options.skillSourceDir = rest[++index];
      continue;
    }
    if (arg === "--target") {
      options.targetDir = rest[++index];
      continue;
    }
    if (arg === "--skill-target") {
      options.skillTargetDir = rest[++index];
      continue;
    }
    if (arg === "--temp-root") {
      options.tempRoot = rest[++index];
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === "check") {
    const result = await checkOhMyOpenAgentArchive({
      generatedDir: options.generatedDir,
      skillSourceDir: options.skillSourceDir,
      targetDir: options.targetDir,
      skillTargetDir: options.skillTargetDir,
      tempRoot: options.tempRoot
    });
    if (options.json) {
      console.log(JSON.stringify(result));
    } else if (result.ok) {
      console.log("oh my openagent archive matches pinned upstream");
    } else {
      console.log(`final prompts missing: ${result.finalPrompts.missing.join(", ") || "-"}`);
      console.log(`final prompts changed: ${result.finalPrompts.changed.join(", ") || "-"}`);
      console.log(`final prompts extra: ${result.finalPrompts.extra.join(", ") || "-"}`);
      console.log(`ulw-plan missing: ${result.ulwPlan.missing.join(", ") || "-"}`);
      console.log(`ulw-plan changed: ${result.ulwPlan.changed.join(", ") || "-"}`);
      console.log(`ulw-plan extra: ${result.ulwPlan.extra.join(", ") || "-"}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (options.command === "sync") {
    const result = await syncOhMyOpenAgentArchive({
      generatedDir: options.generatedDir,
      skillSourceDir: options.skillSourceDir,
      targetDir: options.targetDir,
      skillTargetDir: options.skillTargetDir,
      tempRoot: options.tempRoot
    });
    const written = result.written.finalPrompts.length + result.written.ulwPlan.length;
    console.log(`synced ${written} files to ${result.targetDir} and ${result.skillTargetDir}`);
    return;
  }

  throw new Error("usage: sync-oh-my-openagent-final-prompts.mjs <check|sync> [--generated <dir> --skill-source <dir>] [--target <dir>] [--skill-target <dir>] [--temp-root <dir>] [--json]");
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  installSignalCleanup();
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
