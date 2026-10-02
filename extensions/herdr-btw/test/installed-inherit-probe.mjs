// Run with the installed Pi 1.0.0 package launcher, not repository node_modules.
// Uses a private PTY/settings tree and the installed web activation module; no inference or services.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.argv[2];
assert(binary, "Pass the installed Pi package launcher (bypass any credential-loading personal wrapper)");
const webActivation = process.argv[3] ?? join(homedir(), ".pi/agent/git/github.com/nicobailon/pi-web-access/tool-activation.ts");
const root = await mkdtemp(join(tmpdir(), "btw-installed-probe-"));
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const available = ["read", "web_enable", "web_search", "web_fetch"];
const active = ["web_enable", "read"];
try {
	const env = { PATH: process.env.PATH, HOME: root, TERM: "xterm-256color", PI_CODING_AGENT_DIR: root, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
	const version = spawnSync(binary, ["--version"], { env, encoding: "utf8" });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), "1.0.0", "This probe must exercise installed Pi 1.0.0");
	await writeFile(join(root, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [], prompts: [], themes: [], enableTerminalTitle: false }), { mode: 0o600 });
	const setup = join(root, "btw.ts");
	const web = join(root, "web.ts");
	await writeFile(setup, `
import { registerBtwExtension } from ${JSON.stringify(join(extension, "index.ts"))};
import { ContextStore } from ${JSON.stringify(join(extension, "src/context-store.ts"))};
import { createPayload } from ${JSON.stringify(join(extension, "src/core.ts"))};
import { DEFAULT_CONFIG } from ${JSON.stringify(join(extension, "src/config.ts"))};
export default async function(pi) {
 const store = new ContextStore(${JSON.stringify(join(root, "payloads"))});
 process.env.PI_HERDR_BTW_PAYLOAD = await store.create(createPayload({
  createdAt: "now", parentSessionId: "probe", parentPaneId: null,
  metadata: { generatedAt: "now", cwd: ${JSON.stringify(root)}, session: "probe", model: "anthropic/claude-sonnet-4-5" },
  parentSystemPrompt: null, parentActiveTools: ${JSON.stringify(active)}, parentAvailableTools: ${JSON.stringify(available)},
  parentThinkingLevel: "off", messages: [], draftQuestion: "", config: { ...DEFAULT_CONFIG, closeOnExit: false }
 }));
 await registerBtwExtension(pi, { store });
}
`, { mode: 0o600 });
	await writeFile(web, `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { registerWebToolActivation } from ${JSON.stringify(webActivation)};
export default function(pi) {
 const available = ${JSON.stringify(available)};
 const active = ${JSON.stringify(active)};
 for (const name of ["web_search", "web_fetch"]) pi.registerTool({
  name, label: name, description: "Local no-network fixture", parameters: Type.Object({}),
  async execute() { return { content: [{ type: "text", text: "local" }], details: {} }; }
 });
 let loader;
 const register = pi.registerTool;
 pi.registerTool = definition => { if (definition.name === "web_enable") loader = definition; register(definition); };
 registerWebToolActivation(pi, [{ name: "web_search", capability: "search" }, { name: "web_fetch", capability: "fetch" }]);
 pi.registerTool = register;
 let discovered = false;
 pi.on("resources_discover", () => {
  assert.deepEqual(pi.getActiveTools(), active, "BTW restores exact order after web startup selection");
  const registered = new Set(pi.getAllTools().map(tool => tool.name));
  if (process.env.BTW_PROBE_POSITIVE === "1") for (const name of available) assert(registered.has(name), name);
  else assert(!registered.has("web_search"), "CLI active-only control must filter the registry");
  discovered = true;
 });
 pi.registerCommand("btw-probe", { description: "Inference-free probe", handler: async (_args, ctx) => {
  try {
   assert.equal(ctx.mode, "tui"); assert(discovered, "Discovery must precede initial command"); assert(loader);
   const result = await loader.execute();
   if (process.env.BTW_PROBE_POSITIVE === "1") {
    assert(!result.isError, JSON.stringify(result));
    assert.deepEqual(pi.getActiveTools(), [...active, "web_search", "web_fetch"]);
   } else { assert(result.isError); assert.deepEqual(result.details.unavailable, ["web_search", "web_fetch"]); }
   writeFileSync(process.env.BTW_PROBE_RESULT, "PASS");
  } catch (error) { writeFileSync(process.env.BTW_PROBE_RESULT, String(error.stack ?? error)); }
  finally { ctx.shutdown(); }
 }});
}
`, { mode: 0o600 });
	for (const positive of [false, true]) {
		const resultPath = join(root, positive ? "positive-result" : "control-result");
		// Per-process approval applies only to this trusted generated fixture; no persistent trust.
		const args = ["--approve", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", setup, "-e", web, "--tools", (positive ? available : active).join(","), "/btw-probe"];
		const run = spawnSync("script", ["-q", "-e", "-c", [binary, ...args].map(quote).join(" "), "/dev/null"], {
			cwd: root, env: { ...env, BTW_PROBE_POSITIVE: positive ? "1" : "0", BTW_PROBE_RESULT: resultPath },
			encoding: "utf8", input: "", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
		});
		assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stderr}\n${run.stdout}`);
		assert.equal(await readFile(resultPath, "utf8"), "PASS", run.stdout);
		console.log(`Pi 1.0.0 ${positive ? "availability + restoration + actual web_enable" : "active-only registry-filter control"}: PASS`);
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
