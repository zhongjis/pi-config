import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAndEmitLoaded,
  applySettings,
  loadSettings,
  persistToastFor,
  type SettingsAppliers,
  saveAndEmitChanged,
  saveSettings,
} from "../src/settings.js";

/**
 * Tests for persistent settings. Uses two tmp directories:
 * - `globalDir`: redirected via PI_CODING_AGENT_DIR so getAgentDir() returns it.
 *   Simulates `~/.pi/agent/` — the global scope.
 * - `projectDir`: passed explicitly as cwd to load/save.
 *   Simulates the user's project root. Settings live at `<projectDir>/.pi/subagents.json`.
 */
describe("settings persistence", () => {
  let globalDir: string;
  let projectDir: string;
  let originalAgentDirEnv: string | undefined;

  const globalFile = () => join(globalDir, "subagents.json");
  const projectFile = () => join(projectDir, ".pi", "subagents.json");

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "pi-settings-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-settings-project-"));
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
  });

  afterEach(() => {
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeGlobal(obj: unknown) {
    writeFileSync(globalFile(), JSON.stringify(obj));
  }

  function writeProject(obj: unknown) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), JSON.stringify(obj));
  }

  it("returns {} when both files are missing", () => {
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("returns {} when both files are malformed JSON", () => {
    writeFileSync(globalFile(), "not json {{");
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), "also not json");
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("loads from global when no project file", () => {
    writeGlobal({ maxConcurrent: 16 });
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 16 });
  });

  it("loads from project when no global file", () => {
    writeProject({ maxConcurrent: 8, defaultJoinMode: "group" });
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 8, defaultJoinMode: "group" });
  });

  it("merges global + project with project winning on conflicts", () => {
    writeGlobal({ maxConcurrent: 16, defaultJoinMode: "async" });
    writeProject({ maxConcurrent: 4 });
    expect(loadSettings(projectDir)).toEqual({
      maxConcurrent: 4, // project wins
      defaultJoinMode: "async", // from global
    });
  });

  it("round-trips values: saveSettings then loadSettings", () => {
    const settings = {
      maxConcurrent: 7,
      defaultJoinMode: "smart" as const,
      toolDescriptionMode: "compact" as const,
    };
    saveSettings(settings, projectDir);
    expect(loadSettings(projectDir)).toEqual(settings);
  });


  it("round-trips outputTranscript; drops non-boolean", () => {
    saveSettings({ outputTranscript: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ outputTranscript: false });
    saveSettings({ outputTranscript: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ outputTranscript: true });
    writeProject({ outputTranscript: "no" } as any);
    expect(loadSettings(projectDir)).toEqual({}); // non-boolean dropped
  });

  it("saveSettings writes only to the project file; global is untouched", () => {
    writeGlobal({ maxConcurrent: 16 });
    saveSettings({ maxConcurrent: 2 }, projectDir);

    // Project file contains the new value
    expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 2 });
    // Global file unchanged
    expect(JSON.parse(readFileSync(globalFile(), "utf-8"))).toEqual({ maxConcurrent: 16 });
  });

  it("saveSettings creates <cwd>/.pi/ when missing", () => {
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    saveSettings({ maxConcurrent: 4 }, projectDir);
    expect(existsSync(projectFile())).toBe(true);
  });

  it("ignores unknown extra fields on load (forward-compat)", () => {
    writeProject({ maxConcurrent: 2, futureField: "ignored" });
    const loaded = loadSettings(projectDir);
    expect(loaded.maxConcurrent).toBe(2);
    // Unknown fields are stripped by the sanitizer — old versions won't persist garbage
    expect((loaded as Record<string, unknown>).futureField).toBeUndefined();
  });

  it("composes partial global + partial project correctly", () => {
    writeGlobal({ scopeModels: true });
    writeProject({ maxConcurrent: 2 });
    expect(loadSettings(projectDir)).toEqual({ scopeModels: true, maxConcurrent: 2 });
  });

  describe("sanitizer", () => {
    it("drops maxConcurrent < 1", () => {
      writeProject({ maxConcurrent: 0 });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("drops negative maxConcurrent", () => {
      writeProject({ maxConcurrent: -3 });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("drops non-integer maxConcurrent (floats, NaN, strings)", () => {
      writeProject({ maxConcurrent: 3.5 });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
      writeProject({ maxConcurrent: "four" });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
      writeProject({ maxConcurrent: null });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
    });

    it("drops invalid defaultJoinMode values", () => {
      writeProject({ defaultJoinMode: "invalid" });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ defaultJoinMode: 42 });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ defaultJoinMode: "" });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("accepts all three valid join modes", () => {
      for (const mode of ["async", "group", "smart"] as const) {
        writeProject({ defaultJoinMode: mode });
        expect(loadSettings(projectDir)).toEqual({ defaultJoinMode: mode });
      }
    });

    it("accepts scopeModels boolean (true and false)", () => {
      writeProject({ scopeModels: true });
      expect(loadSettings(projectDir)).toEqual({ scopeModels: true });
      writeProject({ scopeModels: false });
      expect(loadSettings(projectDir)).toEqual({ scopeModels: false });
    });

    it("accepts decisionGateMinConfidence within [0, 1]", () => {
      for (const value of [0, 0.65, 1]) {
        writeProject({ decisionGateMinConfidence: value });
        expect(loadSettings(projectDir)).toEqual({ decisionGateMinConfidence: value });
      }
    });

    it("drops out-of-range or non-numeric decisionGateMinConfidence", () => {
      for (const value of [-0.1, 1.5, "0.8", null, true]) {
        writeProject({ decisionGateMinConfidence: value });
        expect(loadSettings(projectDir).decisionGateMinConfidence).toBeUndefined();
      }
    });

    it("drops non-boolean scopeModels", () => {
      writeProject({ scopeModels: "yes" });
      expect(loadSettings(projectDir).scopeModels).toBeUndefined();
      writeProject({ scopeModels: 1 });
      expect(loadSettings(projectDir).scopeModels).toBeUndefined();
      writeProject({ scopeModels: null });
      expect(loadSettings(projectDir).scopeModels).toBeUndefined();
    });

    it("accepts disableDefaultAgents boolean (true and false)", () => {
      writeProject({ disableDefaultAgents: true });
      expect(loadSettings(projectDir)).toEqual({ disableDefaultAgents: true });
      writeProject({ disableDefaultAgents: false });
      expect(loadSettings(projectDir)).toEqual({ disableDefaultAgents: false });
    });

    it("drops non-boolean disableDefaultAgents", () => {
      writeProject({ disableDefaultAgents: "yes" });
      expect(loadSettings(projectDir).disableDefaultAgents).toBeUndefined();
      writeProject({ disableDefaultAgents: 1 });
      expect(loadSettings(projectDir).disableDefaultAgents).toBeUndefined();
      writeProject({ disableDefaultAgents: null });
      expect(loadSettings(projectDir).disableDefaultAgents).toBeUndefined();
    });

    it("accepts all valid toolDescriptionMode values", () => {
      for (const mode of ["full", "compact", "custom"] as const) {
        writeProject({ toolDescriptionMode: mode });
        expect(loadSettings(projectDir)).toEqual({ toolDescriptionMode: mode });
      }
    });

    it("drops invalid toolDescriptionMode", () => {
      writeProject({ toolDescriptionMode: "tiny" });
      expect(loadSettings(projectDir).toolDescriptionMode).toBeUndefined();
      writeProject({ toolDescriptionMode: true });
      expect(loadSettings(projectDir).toolDescriptionMode).toBeUndefined();
      writeProject({ toolDescriptionMode: null });
      expect(loadSettings(projectDir).toolDescriptionMode).toBeUndefined();
    });

    it("returns {} when the JSON root is not an object (array, string, null)", () => {
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectFile(), '["not", "an", "object"]');
      expect(loadSettings(projectDir)).toEqual({});
      writeFileSync(projectFile(), '"just a string"');
      expect(loadSettings(projectDir)).toEqual({});
      writeFileSync(projectFile(), "null");
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("keeps valid fields while dropping invalid siblings", () => {
      writeProject({
        maxConcurrent: 4, // ok
        defaultJoinMode: "nope", // dropped
      });
      expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 4 });
    });

    it("accepts values at the ceiling (maxConcurrent=1024)", () => {
      writeProject({ maxConcurrent: 1024 });
      expect(loadSettings(projectDir)).toEqual({
        maxConcurrent: 1024,
      });
    });

    it("drops values above the ceiling", () => {
      writeProject({ maxConcurrent: 1025 });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
    });

    it("drops absurdly large values (e.g. 1e6)", () => {
      writeProject({ maxConcurrent: 1_000_000 });
      expect(loadSettings(projectDir)).toEqual({});
    });
  });

  describe("save result + corrupt-file warning", () => {
    it("saveSettings returns true on success", () => {
      expect(saveSettings({ maxConcurrent: 2 }, projectDir)).toBe(true);
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 2 });
    });

    it("saveSettings returns false when the target dir cannot be created", () => {
      // Place a regular file where the parent of the settings file would go —
      // mkdirSync + writeFileSync both fail with ENOTDIR / EEXIST.
      const filePosingAsCwd = join(tmpdir(), `pi-settings-notdir-${Date.now()}`);
      writeFileSync(filePosingAsCwd, "");
      try {
        expect(saveSettings({ maxConcurrent: 1 }, filePosingAsCwd)).toBe(false);
      } finally {
        rmSync(filePosingAsCwd, { force: true });
      }
    });

    it("warns to console.warn when an existing file is malformed", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectFile(), "not valid json {{{");
      try {
        expect(loadSettings(projectDir)).toEqual({});
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0][0])).toMatch(/Ignoring malformed settings/);
      } finally {
        spy.mockRestore();
      }
    });

    it("does NOT warn when a file is simply missing", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(loadSettings(projectDir)).toEqual({});
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("applySettings", () => {
    let appliers: SettingsAppliers;

    beforeEach(() => {
      appliers = {
        setMaxConcurrent: vi.fn(),
        setDefaultJoinMode: vi.fn(),
        setScopeModels: vi.fn(),
        setDisableDefaultAgents: vi.fn(),
        setToolDescriptionMode: vi.fn(),
        setOutputTranscript: vi.fn(),
      };
    });

    it("is a no-op on an empty settings object", () => {
      applySettings({}, appliers);
      expect(appliers.setMaxConcurrent).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
      expect(appliers.setScopeModels).not.toHaveBeenCalled();
      expect(appliers.setDisableDefaultAgents).not.toHaveBeenCalled();
      expect(appliers.setToolDescriptionMode).not.toHaveBeenCalled();
    });

    it("applies only the fields that are present", () => {
      applySettings({ maxConcurrent: 4 }, appliers);
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(4);
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
      expect(appliers.setScopeModels).not.toHaveBeenCalled();
    });

    it("applies all fields when all are present", () => {
      applySettings(
        {
          maxConcurrent: 8,
          defaultJoinMode: "group",
          scopeModels: true,
          disableDefaultAgents: true,
          toolDescriptionMode: "compact",
        },
        appliers,
      );
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(8);
      expect(appliers.setDefaultJoinMode).toHaveBeenCalledWith("group");
      expect(appliers.setScopeModels).toHaveBeenCalledWith(true);
      expect(appliers.setDisableDefaultAgents).toHaveBeenCalledWith(true);
      expect(appliers.setToolDescriptionMode).toHaveBeenCalledWith("compact");
    });

    it("applies decisionGateMinConfidence, including 0; skips it when absent", () => {
      const setDecisionGateMinConfidence = vi.fn();
      applySettings({ decisionGateMinConfidence: 0 }, { ...appliers, setDecisionGateMinConfidence });
      applySettings({}, { ...appliers, setDecisionGateMinConfidence });
      expect(setDecisionGateMinConfidence).toHaveBeenCalledOnce();
      expect(setDecisionGateMinConfidence).toHaveBeenCalledWith(0);
    });

    it("applies scopeModels: false", () => {
      applySettings({ scopeModels: false }, appliers);
      expect(appliers.setScopeModels).toHaveBeenCalledWith(false);
    });

    it("applies disableDefaultAgents: false", () => {
      applySettings({ disableDefaultAgents: false }, appliers);
      expect(appliers.setDisableDefaultAgents).toHaveBeenCalledWith(false);
    });

    it("applies toolDescriptionMode", () => {
      applySettings({ toolDescriptionMode: "full" }, appliers);
      expect(appliers.setToolDescriptionMode).toHaveBeenCalledWith("full");
    });

    it("applies outputTranscript (both true and false)", () => {
      applySettings({ outputTranscript: false }, appliers);
      expect(appliers.setOutputTranscript).toHaveBeenCalledWith(false);
      applySettings({ outputTranscript: true }, appliers);
      expect(appliers.setOutputTranscript).toHaveBeenCalledWith(true);
    });

  });

  describe("persistToastFor", () => {
    it("returns info-level toast with the plain message on success", () => {
      expect(persistToastFor("Max concurrency set to 7", true)).toEqual({
        message: "Max concurrency set to 7",
        level: "info",
      });
    });

    it("returns warning-level toast with session-only suffix on failure", () => {
      expect(persistToastFor("Max concurrency set to 7", false)).toEqual({
        message: "Max concurrency set to 7 (session only; failed to persist)",
        level: "warning",
      });
    });
  });

  describe("applyAndEmitLoaded", () => {
    let appliers: SettingsAppliers;

    beforeEach(() => {
      appliers = {
        setMaxConcurrent: vi.fn(),
        setDefaultJoinMode: vi.fn(),
        setScopeModels: vi.fn(),
        setDisableDefaultAgents: vi.fn(),
        setToolDescriptionMode: vi.fn(),
        setOutputTranscript: vi.fn(),
      };
    });

    it("loads, applies, and emits subagents:settings_loaded with merged settings", () => {
      writeGlobal({ maxConcurrent: 16 });
      writeProject({ scopeModels: true });
      const emit = vi.fn();

      const result = applyAndEmitLoaded(appliers, emit, projectDir);

      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(16);
      expect(appliers.setScopeModels).toHaveBeenCalledWith(true);
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", {
        settings: { maxConcurrent: 16, scopeModels: true },
      });
      expect(result).toEqual({ maxConcurrent: 16, scopeModels: true });
    });

    it("still emits the event when both files are missing (payload carries {})", () => {
      const emit = vi.fn();

      const result = applyAndEmitLoaded(appliers, emit, projectDir);

      expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", { settings: {} });
      expect(result).toEqual({});
      // No setters fired — defaults preserved
      expect(appliers.setMaxConcurrent).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
    });
  });

  describe("saveAndEmitChanged", () => {
    it("persists, emits with persisted=true, and returns info toast on success", () => {
      const emit = vi.fn();
      const snapshot = { maxConcurrent: 5 };

      const toast = saveAndEmitChanged(snapshot, "Max concurrency set to 5", emit, projectDir);

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith("subagents:settings_changed", {
        settings: snapshot,
        persisted: true,
      });
      expect(toast).toEqual({ message: "Max concurrency set to 5", level: "info" });
      // File actually written
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual(snapshot);
    });

    it("emits with persisted=false and returns warning toast on save failure", () => {
      const filePosingAsCwd = join(tmpdir(), `pi-settings-notdir-${Date.now()}`);
      writeFileSync(filePosingAsCwd, "");
      const emit = vi.fn();
      try {
        const toast = saveAndEmitChanged(
          { maxConcurrent: 5 },
          "Max concurrency set to 5",
          emit,
          filePosingAsCwd,
        );
        expect(emit).toHaveBeenCalledWith("subagents:settings_changed", {
          settings: { maxConcurrent: 5 },
          persisted: false,
        });
        expect(toast).toEqual({
          message: "Max concurrency set to 5 (session only; failed to persist)",
          level: "warning",
        });
      } finally {
        rmSync(filePosingAsCwd, { force: true });
      }
    });
  });
});
