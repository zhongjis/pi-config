import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MANAGER_VERSION_GLOBAL_KEY = "__pandaSubagentsManagerVersion";
const FAKE_PI = { events: { emit: () => undefined } } as unknown as Parameters<
  typeof import("../src/index.js").default
>[0];

type PandaGlobal = typeof globalThis & {
  [MANAGER_VERSION_GLOBAL_KEY]?: string;
};

// pandaWarn is mocked so the version-conflict assertion observes the emit call directly,
// independent of the runtime sink the real entry installs via installPandaWarnFileSink.
// vi.hoisted keeps a stable mock instance across the vi.resetModules() re-imports below.
const { pandaWarn } = vi.hoisted(() => ({ pandaWarn: vi.fn() }));
vi.mock("../../lib/warn.js", () => ({
  pandaWarn,
  installPandaWarnFileSink: vi.fn(),
}));

vi.mock("../src/lifecycle/supervision.js", () => ({
  registerSubagentRuntime: vi.fn(),
  formatAgentDefinitionDiagnostic: vi.fn(),
  formatAgentDefinitionDiagnostics: vi.fn(),
  formatInvalidAgentDefinitionMessage: vi.fn(),
}));

async function loadFreshIndex(): Promise<typeof import("../src/index.js")> {
  vi.resetModules();
  return await import("../src/index.js");
}

function clearManagerVersionGlobal() {
  const pandaGlobal = globalThis as PandaGlobal;
  delete pandaGlobal[MANAGER_VERSION_GLOBAL_KEY];
}

describe("subagent symbol version guard", () => {
  beforeEach(() => {
    clearManagerVersionGlobal();
    pandaWarn.mockClear();
  });

  afterEach(() => {
    clearManagerVersionGlobal();
  });

  it("claims the version slot and does not warn on first registration", async () => {
    const mod = await loadFreshIndex();

    mod.default(FAKE_PI);

    expect((globalThis as PandaGlobal)[MANAGER_VERSION_GLOBAL_KEY]).toBe("1.0.0");
    expect(pandaWarn).not.toHaveBeenCalled();
  });

  it("does not warn when another @panda 1.0.0 manager already registered (last-write-wins, same version)", async () => {
    (globalThis as PandaGlobal)[MANAGER_VERSION_GLOBAL_KEY] = "1.0.0";

    const mod = await loadFreshIndex();
    mod.default(FAKE_PI);

    expect((globalThis as PandaGlobal)[MANAGER_VERSION_GLOBAL_KEY]).toBe("1.0.0");
    expect(pandaWarn).not.toHaveBeenCalled();
  });

  it("emits subagent.symbol.version-conflict and takes over on mismatch", async () => {
    (globalThis as PandaGlobal)[MANAGER_VERSION_GLOBAL_KEY] = "0.6.3";

    const mod = await loadFreshIndex();
    mod.default(FAKE_PI);

    expect(pandaWarn).toHaveBeenCalledTimes(1);
    expect(pandaWarn).toHaveBeenCalledWith("subagent.symbol.version-conflict", {
      expectedVersion: "1.0.0",
      previousVersion: "0.6.3",
      resolution: "last-write-wins",
    });

    // Last-write-wins: the @panda fork takes over the version slot.
    expect((globalThis as PandaGlobal)[MANAGER_VERSION_GLOBAL_KEY]).toBe("1.0.0");
  });

  it("warns at most once per process even with multiple mismatched re-registrations", async () => {
    (globalThis as PandaGlobal)[MANAGER_VERSION_GLOBAL_KEY] = "0.6.3";
    const mod = await loadFreshIndex();
    mod.default(FAKE_PI);

    // Simulate another stale manager stomping the slot between registrations.
    (globalThis as PandaGlobal)[MANAGER_VERSION_GLOBAL_KEY] = "0.6.3";
    mod.default(FAKE_PI);

    expect(pandaWarn).toHaveBeenCalledTimes(1);
  });
});
