import { type GitNexusConfig, saveConfig } from "../gitnexus.js";

export type SettingsUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
};

type SettingId = "autoAugment" | "augmentTimeout" | "maxAugmentsPerResult" | "maxSecondaryPatterns" | "mcpIdleTimeout" | "cmd";

type Setting = {
  id: SettingId;
  label: string;
  currentValue: () => string;
  values?: string[];
};

export async function openSettingsMenu(
  ui: SettingsUI,
  cfg: GitNexusConfig,
  state: { augmentEnabled: boolean },
  applyChanges: () => void,
): Promise<void> {
  const settings: Setting[] = [
    {
      id: "autoAugment",
      label: "Auto-augment",
      currentValue: () => (state.augmentEnabled ? "on" : "off"),
      values: ["on", "off"],
    },
    {
      id: "augmentTimeout",
      label: "Augment timeout",
      currentValue: () => String(cfg.augmentTimeout ?? 8),
      values: ["4", "6", "8", "10", "15", "20"],
    },
    {
      id: "maxAugmentsPerResult",
      label: "Max augments per result",
      currentValue: () => String(cfg.maxAugmentsPerResult ?? 3),
      values: ["1", "2", "3", "5"],
    },
    {
      id: "maxSecondaryPatterns",
      label: "Max secondary patterns",
      currentValue: () => String(cfg.maxSecondaryPatterns ?? 2),
      values: ["0", "1", "2", "3", "5"],
    },
    {
      id: "mcpIdleTimeout",
      label: "MCP idle timeout",
      currentValue: () => cfg.mcpIdleTimeout === 0 ? "off" : String(cfg.mcpIdleTimeout ?? 600),
      values: ["off", "60", "300", "600", "1800", "3600"],
    },
    {
      id: "cmd",
      label: "GitNexus command",
      currentValue: () => cfg.cmd ?? "gitnexus",
    },
  ];

  while (true) {
    const choices = settings.map((setting) => `${setting.label}: ${setting.currentValue()}`);
    choices.push("Back");

    const choice = await ui.select("GitNexus Settings", choices);
    if (!choice || choice === "Back") break;

    const index = choices.indexOf(choice);
    const setting = settings[index];
    if (!setting) continue;

    const newValue = setting.id === "cmd"
      ? await ui.input("GitNexus command", setting.currentValue())
      : await ui.select(setting.label, setting.values ?? []);
    if (!newValue) continue;

    applySetting(setting.id, newValue, cfg, state);
    saveConfig(cfg);
    applyChanges();
  }
}

function applySetting(
  id: SettingId,
  newValue: string,
  cfg: GitNexusConfig,
  state: { augmentEnabled: boolean },
): void {
  if (id === "autoAugment") {
    state.augmentEnabled = newValue === "on";
    cfg.autoAugment = state.augmentEnabled;
    return;
  }

  if (id === "augmentTimeout") {
    cfg.augmentTimeout = parseInt(newValue, 10);
    return;
  }

  if (id === "maxAugmentsPerResult") {
    cfg.maxAugmentsPerResult = parseInt(newValue, 10);
    return;
  }

  if (id === "maxSecondaryPatterns") {
    cfg.maxSecondaryPatterns = parseInt(newValue, 10);
    return;
  }

  if (id === "mcpIdleTimeout") {
    cfg.mcpIdleTimeout = newValue === "off" ? 0 : parseInt(newValue, 10);
    return;
  }

  cfg.cmd = newValue.trim() || undefined;
}
