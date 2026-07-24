#!/usr/bin/env bun
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_SHA = "60201be160749965b9bb4c3b2744e1bbee820dc5";
const EXPECTED_VERSION = "4.19.1";
const FROZEN_DATE = "2026-01-01T00:00:00.000Z";
const REPOSITORY = "https://github.com/code-yeongyu/oh-my-openagent";
const MANIFEST_FILE = ".omo-final-prompts.json";
const KNOWN_PLACEHOLDERS = [
  "{CATEGORY_SECTION}",
  "{AGENT_SECTION}",
  "{DECISION_MATRIX}",
  "{SKILLS_SECTION}",
  "{{CATEGORY_SKILLS_DELEGATION_GUIDE}}",
  "{GPT_APPLY_PATCH_GUIDANCE}",
  "{GPT_FILE_EDIT_GUIDANCE}",
  "{KIMI_TOOL_LOOP_GUARD}"
] as const;

type AgentResult = { prompt?: unknown; instructions?: unknown };
type PromptEntry = {
  path: string;
  model?: string;
  expectedFamily: string;
  resolveFamily: (model?: string) => string;
  build: () => AgentResult | string;
};

type CliOptions = {
  sourceDir: string;
  outputDir: string;
  expectedSha: string;
  expectedVersion: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.sourceDir = argv[++index];
    else if (arg === "--output") options.outputDir = argv[++index];
    else if (arg === "--sha") options.expectedSha = argv[++index];
    else if (arg === "--version") options.expectedVersion = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const [name, value] of Object.entries(options)) {
    if (!value) throw new Error(`${name} is required`);
  }
  if (!options.sourceDir) throw new Error("sourceDir is required");
  if (!options.outputDir) throw new Error("outputDir is required");
  if (!options.expectedSha) throw new Error("expectedSha is required");
  if (!options.expectedVersion) throw new Error("expectedVersion is required");
  return options as CliOptions;
}

async function importSource(sourceDir: string, relativePath: string) {
  return await import(pathToFileURL(join(sourceDir, relativePath)).href);
}

function extractPrompt(result: AgentResult | string, path: string): string {
  const value = typeof result === "string"
    ? result
    : result.prompt !== undefined
      ? result.prompt
      : result.instructions;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`empty prompt returned for ${path}`);
  }
  for (const placeholder of KNOWN_PLACEHOLDERS) {
    if (value.includes(placeholder)) {
      throw new Error(`unresolved placeholder ${placeholder} in ${path}`);
    }
  }
  return value.endsWith("\n") ? value : `${value}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.expectedSha !== EXPECTED_SHA || options.expectedVersion !== EXPECTED_VERSION) {
    throw new Error(`export pin mismatch: expected ${EXPECTED_SHA} / ${EXPECTED_VERSION}`);
  }

  const packageJson = JSON.parse(await readFile(join(options.sourceDir, "package.json"), "utf8"));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(`upstream package version mismatch: expected ${EXPECTED_VERSION}, got ${packageJson.version}`);
  }

  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      switch (args.length) {
        case 0: super(FROZEN_DATE); break;
        case 1: super(args[0] as string); break;
        case 2: super(args[0] as number, args[1] as number); break;
        case 3: super(args[0] as number, args[1] as number, args[2] as number); break;
        case 4: super(args[0] as number, args[1] as number, args[2] as number, args[3] as number); break;
        case 5: super(args[0] as number, args[1] as number, args[2] as number, args[3] as number, args[4] as number); break;
        case 6: super(args[0] as number, args[1] as number, args[2] as number, args[3] as number, args[4] as number, args[5] as number); break;
        default: super(args[0] as number, args[1] as number, args[2] as number, args[3] as number, args[4] as number, args[5] as number, args[6] as number);
      }
    }

    getFullYear() {
      return 2026;
    }

    static now() {
      return new RealDate(FROZEN_DATE).getTime();
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;

  try {
    const agentsRoot = "packages/omo-opencode/src/agents";
    const [
      sisyphus,
      hephaestus,
      oracle,
      librarian,
      explore,
      multimodalLooker,
      metis,
      momus,
      atlas,
      prometheus,
      sisyphusJunior,
      modelTypes,
      ultrawork
    ] = await Promise.all([
      importSource(options.sourceDir, `${agentsRoot}/sisyphus-agent-factory.ts`),
      importSource(options.sourceDir, `${agentsRoot}/hephaestus/agent.ts`),
      importSource(options.sourceDir, `${agentsRoot}/oracle.ts`),
      importSource(options.sourceDir, `${agentsRoot}/librarian.ts`),
      importSource(options.sourceDir, `${agentsRoot}/explore.ts`),
      importSource(options.sourceDir, `${agentsRoot}/multimodal-looker.ts`),
      importSource(options.sourceDir, `${agentsRoot}/metis.ts`),
      importSource(options.sourceDir, `${agentsRoot}/momus.ts`),
      importSource(options.sourceDir, `${agentsRoot}/atlas/agent.ts`),
      importSource(options.sourceDir, `${agentsRoot}/prometheus/system-prompt.ts`),
      importSource(options.sourceDir, `${agentsRoot}/sisyphus-junior/agent.ts`),
      importSource(options.sourceDir, `${agentsRoot}/types.ts`),
      importSource(options.sourceDir, "packages/prompts-core/src/ultrawork-prompts.ts")
    ]);

    const resolveOracleFamily = (model?: string) => {
      if (model && (modelTypes.isGpt5_5Model(model) || modelTypes.isGpt5_6Model(model))) return "gpt-5-5";
      if (model && modelTypes.isGptModel(model)) return "gpt";
      return "default";
    };
    const resolveMomusFamily = (model?: string) => {
      if (model && modelTypes.isGpt5_6Model(model)) return "gpt-5-6";
      if (model && modelTypes.isGptModel(model)) return "gpt";
      return "default";
    };
    const resolveMetisFamily = (model?: string) => model && modelTypes.isKimiK27Model(model)
      ? "kimi-k2-7"
      : "default";
    const onlyDefault = () => "default";
    const frozenDynamicArgs = [[], [], [], [], false] as const;
    const buildSisyphus = (model: string) => sisyphus.createSisyphusAgent(model, ...frozenDynamicArgs);
    const buildHephaestus = (model: string) => {
      const agent = hephaestus.createHephaestusAgent(model, ...frozenDynamicArgs);
      if (agent.prompt !== hephaestus.getHephaestusPrompt(model, false)) {
        throw new Error(`Hephaestus builder mismatch for ${model}`);
      }
      return agent;
    };
    const buildAtlas = (model: string) => atlas.createAtlasAgent({
      model,
      availableAgents: [],
      availableSkills: [],
      userCategories: {}
    });
    const buildJunior = (model: string) => {
      const agent = sisyphusJunior.createSisyphusJuniorAgentWithOverrides({ model }, undefined, false);
      if (agent.prompt !== sisyphusJunior.buildSisyphusJuniorPrompt(model, false, undefined)) {
        throw new Error(`Sisyphus-Junior builder mismatch for ${model}`);
      }
      return agent;
    };

    const entries: PromptEntry[] = [
      { path: "atlas/default.md", model: "anthropic/claude-sonnet-4-6", expectedFamily: "default", resolveFamily: atlas.getAtlasPromptSource, build: () => buildAtlas("anthropic/claude-sonnet-4-6") },
      { path: "atlas/gemini.md", model: "google/gemini-3.1-pro", expectedFamily: "gemini", resolveFamily: atlas.getAtlasPromptSource, build: () => buildAtlas("google/gemini-3.1-pro") },
      { path: "atlas/glm.md", model: "zai-coding-plan/glm-5.2", expectedFamily: "glm", resolveFamily: atlas.getAtlasPromptSource, build: () => buildAtlas("zai-coding-plan/glm-5.2") },
      { path: "atlas/gpt.md", model: "openai/gpt-5.5", expectedFamily: "gpt", resolveFamily: atlas.getAtlasPromptSource, build: () => buildAtlas("openai/gpt-5.5") },
      { path: "atlas/kimi-k2-7.md", model: "opencode-go/kimi-k2.7", expectedFamily: "kimi-k2-7", resolveFamily: atlas.getAtlasPromptSource, build: () => buildAtlas("opencode-go/kimi-k2.7") },
      { path: "atlas/kimi-k3.md", model: "opencode-go/kimi-k3", expectedFamily: "kimi-k3", resolveFamily: atlas.getAtlasPromptSource, build: () => buildAtlas("opencode-go/kimi-k3") },
      { path: "atlas/kimi.md", model: "opencode-go/kimi-k2.6", expectedFamily: "kimi", resolveFamily: atlas.getAtlasPromptSource, build: () => buildAtlas("opencode-go/kimi-k2.6") },
      { path: "atlas/opus-4-7.md", model: "anthropic/claude-opus-4-7", expectedFamily: "opus-4-7", resolveFamily: atlas.getAtlasPromptSource, build: () => buildAtlas("anthropic/claude-opus-4-7") },
      { path: "explore/default.md", model: "anthropic/claude-haiku-4-5", expectedFamily: "default", resolveFamily: onlyDefault, build: () => explore.createExploreAgent("anthropic/claude-haiku-4-5") },
      { path: "hephaestus/gpt-5-4.md", model: "openai/gpt-5.4", expectedFamily: "gpt-5-4", resolveFamily: hephaestus.getHephaestusPromptSource, build: () => buildHephaestus("openai/gpt-5.4") },
      { path: "hephaestus/gpt-5-5.md", model: "openai/gpt-5.5", expectedFamily: "gpt-5-5", resolveFamily: hephaestus.getHephaestusPromptSource, build: () => buildHephaestus("openai/gpt-5.5") },
      { path: "hephaestus/gpt-5-6.md", model: "openai/gpt-5.6", expectedFamily: "gpt-5-6", resolveFamily: hephaestus.getHephaestusPromptSource, build: () => buildHephaestus("openai/gpt-5.6") },
      { path: "hephaestus/gpt.md", model: "openai/gpt-5.3-codex", expectedFamily: "gpt", resolveFamily: hephaestus.getHephaestusPromptSource, build: () => buildHephaestus("openai/gpt-5.3-codex") },
      { path: "librarian/default.md", model: "anthropic/claude-sonnet-4-6", expectedFamily: "default", resolveFamily: onlyDefault, build: () => librarian.createLibrarianAgent("anthropic/claude-sonnet-4-6") },
      { path: "metis/default.md", model: "anthropic/claude-sonnet-4-6", expectedFamily: "default", resolveFamily: resolveMetisFamily, build: () => metis.createMetisAgent("anthropic/claude-sonnet-4-6") },
      { path: "metis/kimi-k2-7.md", model: "opencode-go/kimi-k2.7", expectedFamily: "kimi-k2-7", resolveFamily: resolveMetisFamily, build: () => metis.createMetisAgent("opencode-go/kimi-k2.7") },
      { path: "momus/default.md", model: "anthropic/claude-sonnet-4-6", expectedFamily: "default", resolveFamily: resolveMomusFamily, build: () => momus.createMomusAgent("anthropic/claude-sonnet-4-6") },
      { path: "momus/gpt-5-6.md", model: "openai/gpt-5.6", expectedFamily: "gpt-5-6", resolveFamily: resolveMomusFamily, build: () => momus.createMomusAgent("openai/gpt-5.6") },
      { path: "momus/gpt.md", model: "openai/gpt-5.5", expectedFamily: "gpt", resolveFamily: resolveMomusFamily, build: () => momus.createMomusAgent("openai/gpt-5.5") },
      { path: "multimodal-looker/default.md", model: "google/gemini-3-flash", expectedFamily: "default", resolveFamily: onlyDefault, build: () => multimodalLooker.createMultimodalLookerAgent("google/gemini-3-flash") },
      { path: "oracle/default.md", model: "anthropic/claude-opus-4-6", expectedFamily: "default", resolveFamily: resolveOracleFamily, build: () => oracle.createOracleAgent("anthropic/claude-opus-4-6") },
      { path: "oracle/gpt-5-5.md", model: "openai/gpt-5.5", expectedFamily: "gpt-5-5", resolveFamily: resolveOracleFamily, build: () => oracle.createOracleAgent("openai/gpt-5.5") },
      { path: "oracle/gpt.md", model: "openai/gpt-5.4", expectedFamily: "gpt", resolveFamily: resolveOracleFamily, build: () => oracle.createOracleAgent("openai/gpt-5.4") },
      { path: "prometheus/default.md", expectedFamily: "default", resolveFamily: onlyDefault, build: () => prometheus.getPrometheusPrompt(undefined, []) },
      { path: "sisyphus-junior/default.md", model: "anthropic/claude-sonnet-4-6", expectedFamily: "default", resolveFamily: sisyphusJunior.getSisyphusJuniorPromptSource, build: () => buildJunior("anthropic/claude-sonnet-4-6") },
      { path: "sisyphus-junior/gemini.md", model: "google/gemini-3.1-pro", expectedFamily: "gemini", resolveFamily: sisyphusJunior.getSisyphusJuniorPromptSource, build: () => buildJunior("google/gemini-3.1-pro") },
      { path: "sisyphus-junior/glm-5-2.md", model: "zai-coding-plan/glm-5.2", expectedFamily: "glm-5-2", resolveFamily: sisyphusJunior.getSisyphusJuniorPromptSource, build: () => buildJunior("zai-coding-plan/glm-5.2") },
      { path: "sisyphus-junior/gpt-5-4.md", model: "openai/gpt-5.4", expectedFamily: "gpt-5-4", resolveFamily: sisyphusJunior.getSisyphusJuniorPromptSource, build: () => buildJunior("openai/gpt-5.4") },
      { path: "sisyphus-junior/gpt-5-5.md", model: "openai/gpt-5.5", expectedFamily: "gpt-5-5", resolveFamily: sisyphusJunior.getSisyphusJuniorPromptSource, build: () => buildJunior("openai/gpt-5.5") },
      { path: "sisyphus-junior/gpt.md", model: "openai/gpt-5.3-codex", expectedFamily: "gpt", resolveFamily: sisyphusJunior.getSisyphusJuniorPromptSource, build: () => buildJunior("openai/gpt-5.3-codex") },
      { path: "sisyphus-junior/kimi-k2-7.md", model: "opencode-go/kimi-k2.7", expectedFamily: "kimi-k2-7", resolveFamily: sisyphusJunior.getSisyphusJuniorPromptSource, build: () => buildJunior("opencode-go/kimi-k2.7") },
      { path: "sisyphus-junior/kimi-k2.md", model: "opencode-go/kimi-k2.6", expectedFamily: "kimi-k2", resolveFamily: sisyphusJunior.getSisyphusJuniorPromptSource, build: () => buildJunior("opencode-go/kimi-k2.6") },
      { path: "sisyphus-junior/kimi-k3.md", model: "opencode-go/kimi-k3", expectedFamily: "kimi-k3", resolveFamily: sisyphusJunior.getSisyphusJuniorPromptSource, build: () => buildJunior("opencode-go/kimi-k3") },
      { path: "sisyphus/claude-fable-5.md", model: "anthropic/claude-fable-5", expectedFamily: "claude-fable-5", resolveFamily: sisyphus.resolveSisyphusPromptFamily, build: () => buildSisyphus("anthropic/claude-fable-5") },
      { path: "sisyphus/claude-opus-4-7.md", model: "anthropic/claude-opus-4-7", expectedFamily: "claude-opus-4-7", resolveFamily: sisyphus.resolveSisyphusPromptFamily, build: () => buildSisyphus("anthropic/claude-opus-4-7") },
      { path: "sisyphus/claude-opus-4-8.md", model: "anthropic/claude-opus-4-8", expectedFamily: "claude-opus-4-8", resolveFamily: sisyphus.resolveSisyphusPromptFamily, build: () => buildSisyphus("anthropic/claude-opus-4-8") },
      { path: "sisyphus/fallback.md", model: "anthropic/claude-sonnet-4-6", expectedFamily: "fallback", resolveFamily: sisyphus.resolveSisyphusPromptFamily, build: () => buildSisyphus("anthropic/claude-sonnet-4-6") },
      { path: "sisyphus/glm-5-2.md", model: "zai-coding-plan/glm-5.2", expectedFamily: "glm-5-2", resolveFamily: sisyphus.resolveSisyphusPromptFamily, build: () => buildSisyphus("zai-coding-plan/glm-5.2") },
      { path: "sisyphus/gpt-5-4.md", model: "openai/gpt-5.4", expectedFamily: "gpt-5-4", resolveFamily: sisyphus.resolveSisyphusPromptFamily, build: () => buildSisyphus("openai/gpt-5.4") },
      { path: "sisyphus/gpt-5-5.md", model: "openai/gpt-5.5", expectedFamily: "gpt-5-5", resolveFamily: sisyphus.resolveSisyphusPromptFamily, build: () => buildSisyphus("openai/gpt-5.5") },
      { path: "sisyphus/kimi-k2-6.md", model: "opencode-go/kimi-k2.6", expectedFamily: "kimi-k2-6", resolveFamily: sisyphus.resolveSisyphusPromptFamily, build: () => buildSisyphus("opencode-go/kimi-k2.6") },
      { path: "sisyphus/kimi-k2-7.md", model: "opencode-go/kimi-k2.7", expectedFamily: "kimi-k2-7", resolveFamily: sisyphus.resolveSisyphusPromptFamily, build: () => buildSisyphus("opencode-go/kimi-k2.7") },
      { path: "sisyphus/kimi-k3.md", model: "opencode-go/kimi-k3", expectedFamily: "kimi-k3", resolveFamily: sisyphus.resolveSisyphusPromptFamily, build: () => buildSisyphus("opencode-go/kimi-k3") },
      { path: "ultrawork/default.md", expectedFamily: "default", resolveFamily: onlyDefault, build: () => ultrawork.ULTRAWORK_DEFAULT_PROMPT },
      { path: "ultrawork/gpt.md", expectedFamily: "default", resolveFamily: onlyDefault, build: () => ultrawork.ULTRAWORK_GPT_PROMPT }
    ];

    if (entries.length !== 45) throw new Error(`expected 45 prompt entries, got ${entries.length}`);
    await rm(options.outputDir, { recursive: true, force: true });
    await mkdir(options.outputDir, { recursive: true });

    for (const entry of entries) {
      const actualFamily = entry.resolveFamily(entry.model);
      if (actualFamily !== entry.expectedFamily) {
        throw new Error(`${entry.path} routed to ${actualFamily}; expected ${entry.expectedFamily}`);
      }
      const body = extractPrompt(entry.build(), entry.path);
      const outputPath = resolve(options.outputDir, entry.path);
      if (!outputPath.startsWith(`${resolve(options.outputDir)}/`)) {
        throw new Error(`output path escapes root: ${entry.path}`);
      }
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, body, "utf8");
    }

    await writeFile(join(options.outputDir, MANIFEST_FILE), `${JSON.stringify({
      repository: REPOSITORY,
      sha: EXPECTED_SHA,
      version: EXPECTED_VERSION,
      frozenDate: FROZEN_DATE.slice(0, 10)
    }, null, 2)}\n`, "utf8");
  } finally {
    globalThis.Date = RealDate;
  }
}

await main();
