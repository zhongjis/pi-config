/**
 * Vitest setup file — patches Node's CJS Module._resolveFilename so that
 * require("@mariozechner/…") inside extension source files resolves to the
 * test stubs instead of the real (possibly broken) packages.
 *
 * This is needed because extensions/session-local/storage.ts uses CJS
 * require() which bypasses Vite's resolve.alias.
 */
import { createRequire } from "node:module";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const stubMap: Record<string, string> = {
  "@mariozechner/pi-coding-agent": resolve(rootDir, "test/stubs/pi-coding-agent.ts"),
  "@mariozechner/pi-tui": resolve(rootDir, "test/stubs/pi-tui.ts"),
  "@mariozechner/pi-ai": resolve(rootDir, "test/stubs/pi-ai.ts"),
  "@mariozechner/pi-agent-core": resolve(rootDir, "test/stubs/pi-agent-core.ts"),
};

const originalResolveFilename = (Module as any)._resolveFilename;

(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any,
) {
  if (stubMap[request]) {
    return stubMap[request];
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
