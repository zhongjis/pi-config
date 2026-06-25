// Mutable runtime flags persisted via subagents.json and toggled from /agents → Settings.
// Module-level state so both the runtime hub (read) and the /agents command (write) share one source.
import type { ToolDescriptionMode } from "./settings.js";

let toolDescriptionMode: ToolDescriptionMode = "full";

export function getToolDescriptionMode(): ToolDescriptionMode {
  return toolDescriptionMode;
}

export function setToolDescriptionMode(mode: ToolDescriptionMode): void {
  toolDescriptionMode = mode;
}

let scopeModels = false;

export function getScopeModels(): boolean {
  return scopeModels;
}

export function setScopeModels(on: boolean): void {
  scopeModels = on;
}
