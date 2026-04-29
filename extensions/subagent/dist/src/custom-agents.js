import { normalizeThinkingLevel } from "./thinking-level.js";
/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project: <cwd>/.pi/agents/*.md
 *   2. Global:  $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
export function loadCustomAgents(cwd) {
    const globalDir = join(getAgentDir(), "agents");
    const projectDir = join(cwd, ".pi", "agents");
    const agents = new Map();
    loadFromDir(globalDir, agents, "global"); // lower priority
    loadFromDir(projectDir, agents, "project"); // higher priority (overwrites)
    return agents;
}
/** Load agent configs from a directory into the map. */
function loadFromDir(dir, agents, source) {
    if (!existsSync(dir))
        return;
    let files;
    try {
        files = readdirSync(dir).filter(f => f.endsWith(".md"));
    }
    catch {
        return;
    }
    for (const file of files) {
        const name = basename(file, ".md");
        let content;
        try {
            content = readFileSync(join(dir, file), "utf-8");
        }
        catch {
            continue;
        }
        const { frontmatter: fm, body } = parseFrontmatter(content);
        agents.set(name, {
            name,
            displayName: str(fm.display_name),
            description: str(fm.description) ?? name,
            builtinToolNames: csvList(fm.tools, BUILTIN_TOOL_NAMES),
            disallowedTools: csvListOptional(fm.disallowed_tools),
            allowDelegationTo: csvListOptional(fm.allow_delegation_to),
            disallowDelegationTo: csvListOptional(fm.disallow_delegation_to),
            allowNesting: fm.allow_nesting === true,
            extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
            skills: inheritField(fm.skills ?? fm.inherit_skills),
            model: str(fm.model),
            thinking: normalizeThinkingLevel(str(fm.thinking)),
            maxTurns: nonNegativeInt(fm.max_turns),
            systemPrompt: body.trim(),
            promptMode: fm.prompt_mode === "append" ? "append" : "replace",
            inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
            runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
            isolated: fm.isolated != null ? fm.isolated === true : undefined,
            memory: parseMemory(fm.memory),
            isolation: fm.isolation === "worktree" ? "worktree" : undefined,
            enabled: fm.enabled !== false, // default true; explicitly false disables
            source,
        });
    }
}
// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.
/** Extract a string or undefined. */
function str(val) {
    return typeof val === "string" ? val : undefined;
}
/** Extract a non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val) {
    return typeof val === "number" && val >= 0 ? val : undefined;
}
/**
 * Parse a raw CSV field value into items, or undefined if absent/empty/"none".
 */
function parseCsvField(val) {
    if (val === undefined || val === null)
        return undefined;
    const s = String(val).trim();
    if (!s || s === "none")
        return undefined;
    const items = s.split(",").map(t => t.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
}
/**
 * Parse a comma-separated list field with defaults.
 * omitted → defaults; "none"/empty → []; csv → listed items.
 */
function csvList(val, defaults) {
    if (val === undefined || val === null)
        return defaults;
    return parseCsvField(val) ?? [];
}
/**
 * Parse an optional comma-separated list field.
 * omitted → undefined; "none"/empty → undefined; csv → listed items.
 */
function csvListOptional(val) {
    return parseCsvField(val);
}
/**
 * Parse a memory scope field.
 * omitted → undefined; "user"/"project"/"local" → MemoryScope.
 */
function parseMemory(val) {
    if (val === "user" || val === "project" || val === "local")
        return val;
    return undefined;
}
/**
 * Parse an inherit field (extensions, skills).
 * omitted/true → true (inherit all); false/"none"/empty → false; csv → listed names.
 */
function inheritField(val) {
    if (val === undefined || val === null || val === true)
        return true;
    if (val === false || val === "none")
        return false;
    const items = csvList(val, []);
    return items.length > 0 ? items : false;
}
