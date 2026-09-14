import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applySettings, loadSettings, type SettingsAppliers, saveSettings } from "../src/settings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subagent-controls-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it("keeps absent controls absent and round-trips explicit defaults and opt-ins", () => {
  expect(loadSettings(dir)).toEqual({});
  for (const maxConcurrentForeground of [0, 1, 1024]) {
    for (const enabled of [false, true]) {
      const settings = { maxConcurrentForeground, reportUsage: enabled, showCost: enabled };
      expect(saveSettings(settings, dir)).toBe(true);
      expect(loadSettings(dir)).toMatchObject(settings);
    }
  }
});

it.each([-1, 1.5, 1025, "4", null])("drops invalid foreground concurrency %s", (value) => {
  saveSettings({ maxConcurrentForeground: value } as unknown as Parameters<typeof saveSettings>[0], dir);
  expect(loadSettings(dir)).not.toHaveProperty("maxConcurrentForeground");
});

it("applies false and unlimited without truthiness loss", () => {
  const setMaxConcurrentForeground = vi.fn();
  const setReportUsage = vi.fn();
  const setShowCost = vi.fn();
  const appliers = { setMaxConcurrentForeground, setReportUsage, setShowCost } as unknown as SettingsAppliers;
  applySettings({ maxConcurrentForeground: 0, reportUsage: false, showCost: false }, appliers);
  expect(setMaxConcurrentForeground).toHaveBeenCalledWith(0);
  expect(setReportUsage).toHaveBeenCalledWith(false);
  expect(setShowCost).toHaveBeenCalledWith(false);
});
