/**
 * isolated-provider.e2e.test.ts — reachability guard for parent model runtime forwarding.
 *
 * agent-runner reads `ctx.modelRegistry.runtime` and forwards it as `modelRuntime`.
 * The unit test in agent-runner.test.ts ("forwards the parent model runtime") guards
 * that forwarding against a mock whose `.runtime` is hand-set. `.runtime` is a private
 * field on the real ModelRegistry; if Pi renames it or makes it truly private, the
 * cast yields undefined and forwarding omits `modelRuntime`. This test asserts the
 * real facade exposes a runtime-reachable `.runtime` that is the runtime it wraps.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("real ModelRegistry exposes .runtime", () => {
  it("ctx.modelRegistry.runtime is reachable and IS the runtime it wraps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iso-prov-"));
    tmpDirs.push(dir);
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });

    const facade = new ModelRegistry(runtime);
    // This is the exact expression agent-runner reads (`ctx.modelRegistry.runtime`).
    expect((facade as unknown as { runtime?: unknown }).runtime).toBe(runtime);
  });
});
