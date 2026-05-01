import { type GitNexusConfig, saveConfig } from "../gitnexus.js";

export type SettingsUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
};

type Setting = {
  id: "autoAugment" | "augmentTimeout" | "maxAugmentsPerResult" | "maxSecondaryPatterns" | "cmd";
  label: string;
  currentValue: () => string;
  values: string[];
};

export async function openSettingsMenu(
  ui: SettingsUI,
  cfg: GitNexusConfig,
  state: { augmentEnabled: boolean },
  onBack: () => Promise<void>,
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
      id: "cmd",
      label: "GitNexus command",
      currentValue: () => cfg.cmd ?? "gitnexus",
      values: ["gitnexus", "npx gitnexus@latest", "npx -y gitnexus@latest"],
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

    const newValue = await ui.select(setting.label, setting.values);
    if (!newValue) continue;

    applySetting(setting.id, newValue, cfg, state);
    saveConfig(cfg);
  }

  return onBack();
}

function applySetting(
  id: Setting["id"],
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

  cfg.cmd = newValue;
}
