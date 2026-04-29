import type { JoinMode } from "./types.js";
export interface SubagentsSettings {
    maxConcurrent?: number;
    /**
     * 0 = unlimited — the extension's single source of truth for that convention:
     * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
     * `/agents` → Settings input prompt explicitly says "0 = unlimited".
     */
    defaultMaxTurns?: number;
    graceTurns?: number;
    defaultJoinMode?: JoinMode;
}
/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
    setMaxConcurrent: (n: number) => void;
    setDefaultMaxTurns: (n: number) => void;
    setGraceTurns: (n: number) => void;
    setDefaultJoinMode: (mode: JoinMode) => void;
}
/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;
/** Load merged settings: global provides defaults, project overrides. */
export declare function loadSettings(cwd?: string): SubagentsSettings;
/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export declare function saveSettings(s: SubagentsSettings, cwd?: string): boolean;
/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export declare function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void;
/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export declare function persistToastFor(successMsg: string, persisted: boolean): {
    message: string;
    level: "info" | "warning";
};
/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export declare function applyAndEmitLoaded(appliers: SettingsAppliers, emit: SettingsEmit, cwd?: string): SubagentsSettings;
/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export declare function saveAndEmitChanged(snapshot: SubagentsSettings, successMsg: string, emit: SettingsEmit, cwd?: string): {
    message: string;
    level: "info" | "warning";
};
