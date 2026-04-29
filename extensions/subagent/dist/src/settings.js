// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
const VALID_JOIN_MODES = new Set(["async", "group", "smart"]);
// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;
/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw) {
    if (!raw || typeof raw !== "object")
        return {};
    const r = raw;
    const out = {};
    if (Number.isInteger(r.maxConcurrent) &&
        r.maxConcurrent >= 1 &&
        r.maxConcurrent <= MAX_CONCURRENT_CEILING) {
        out.maxConcurrent = r.maxConcurrent;
    }
    if (Number.isInteger(r.defaultMaxTurns) &&
        r.defaultMaxTurns >= 0 &&
        r.defaultMaxTurns <= MAX_TURNS_CEILING) {
        out.defaultMaxTurns = r.defaultMaxTurns;
    }
    if (Number.isInteger(r.graceTurns) &&
        r.graceTurns >= 1 &&
        r.graceTurns <= GRACE_TURNS_CEILING) {
        out.graceTurns = r.graceTurns;
    }
    if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode)) {
        out.defaultJoinMode = r.defaultJoinMode;
    }
    return out;
}
function globalPath() {
    return join(getAgentDir(), "subagents.json");
}
function projectPath(cwd) {
    return join(cwd, ".pi", "subagents.json");
}
/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path) {
    if (!existsSync(path))
        return {};
    try {
        return sanitize(JSON.parse(readFileSync(path, "utf-8")));
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
        return {};
    }
}
/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd = process.cwd()) {
    return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}
/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s, cwd = process.cwd()) {
    const path = projectPath(cwd);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
        return true;
    }
    catch {
        return false;
    }
}
/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s, appliers) {
    if (typeof s.maxConcurrent === "number")
        appliers.setMaxConcurrent(s.maxConcurrent);
    if (typeof s.defaultMaxTurns === "number")
        appliers.setDefaultMaxTurns(s.defaultMaxTurns);
    if (typeof s.graceTurns === "number")
        appliers.setGraceTurns(s.graceTurns);
    if (s.defaultJoinMode)
        appliers.setDefaultJoinMode(s.defaultJoinMode);
}
/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(successMsg, persisted) {
    return persisted
        ? { message: successMsg, level: "info" }
        : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}
/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(appliers, emit, cwd = process.cwd()) {
    const settings = loadSettings(cwd);
    applySettings(settings, appliers);
    emit("subagents:settings_loaded", { settings });
    return settings;
}
/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(snapshot, successMsg, emit, cwd = process.cwd()) {
    const persisted = saveSettings(snapshot, cwd);
    emit("subagents:settings_changed", { settings: snapshot, persisted });
    return persistToastFor(successMsg, persisted);
}
