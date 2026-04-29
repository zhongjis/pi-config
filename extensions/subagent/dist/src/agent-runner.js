/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, } from "@mariozechner/pi-coding-agent";
import { getAgentConfig, getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames, getToolNamesForType } from "./agent-types.js";
import { buildParentContext, extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { buildAgentPrompt } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"];
/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns;
/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n) {
    if (n == null || n === 0)
        return undefined;
    return Math.max(1, n);
}
/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns() { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n) { defaultMaxTurns = normalizeMaxTurns(n); }
/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;
/** Get the grace turns value. */
export function getGraceTurns() { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n) { graceTurns = Math.max(1, n); }
/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
function resolveDefaultModel(parentModel, registry, configModel) {
    if (configModel) {
        const slashIdx = configModel.indexOf("/");
        if (slashIdx !== -1) {
            const provider = configModel.slice(0, slashIdx);
            const modelId = configModel.slice(slashIdx + 1);
            // Build a set of available model keys for fast lookup
            const available = registry.getAvailable?.();
            const availableKeys = available
                ? new Set(available.map((m) => `${m.provider}/${m.id}`))
                : undefined;
            const isAvailable = (p, id) => !availableKeys || availableKeys.has(`${p}/${id}`);
            const found = registry.find(provider, modelId);
            if (found && isAvailable(provider, modelId))
                return found;
        }
    }
    return parentModel;
}
/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session) {
    let text = "";
    const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_start") {
            text = "";
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            text += event.assistantMessageEvent.delta;
        }
    });
    return { getText: () => text, unsubscribe };
}
/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
        const msg = session.messages[i];
        if (msg.role !== "assistant")
            continue;
        const text = extractText(msg.content).trim();
        if (text)
            return text;
    }
    return "";
}
/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session, signal) {
    if (!signal)
        return () => { };
    const onAbort = () => session.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
}
export async function runAgent(ctx, type, prompt, options) {
    const config = getConfig(type);
    const agentConfig = getAgentConfig(type);
    // Resolve working directory: worktree override > parent cwd
    const effectiveCwd = options.cwd ?? ctx.cwd;
    const env = await detectEnv(options.pi, effectiveCwd);
    // Get parent system prompt for append-mode agents
    const parentSystemPrompt = ctx.getSystemPrompt();
    // Build prompt extras (memory, skill preloading)
    const extras = {};
    // Resolve extensions/skills: isolated overrides to false
    const extensions = options.isolated ? false : config.extensions;
    const skills = options.isolated ? false : config.skills;
    // Skill preloading: when skills is string[], preload their content into prompt
    if (Array.isArray(skills)) {
        const loaded = preloadSkills(skills, effectiveCwd);
        if (loaded.length > 0) {
            extras.skillBlocks = loaded;
        }
    }
    let toolNames = getToolNamesForType(type);
    // Persistent memory: detect write capability and branch accordingly.
    // Account for disallowedTools — a tool in the base set but on the denylist is not truly available.
    if (agentConfig?.memory) {
        const existingNames = new Set(toolNames);
        const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
        const effectivelyHas = (name) => existingNames.has(name) && !denied?.has(name);
        const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");
        if (hasWriteTools) {
            // Read-write memory: add any missing memory tool names (read/write/edit)
            const extraNames = getMemoryToolNames(existingNames);
            if (extraNames.length > 0)
                toolNames = [...toolNames, ...extraNames];
            extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
        }
        else {
            // Read-only memory: only add read tool name, use read-only prompt
            const extraNames = getReadOnlyMemoryToolNames(existingNames);
            if (extraNames.length > 0)
                toolNames = [...toolNames, ...extraNames];
            extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
        }
    }
    // Build system prompt from agent config
    let systemPrompt;
    if (agentConfig) {
        systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
    }
    else {
        // Unknown type fallback: spread the canonical general-purpose config (defensive —
        // unreachable in practice since index.ts resolves unknown types before calling runAgent).
        const fallback = DEFAULT_AGENTS.get("general-purpose");
        if (!fallback)
            throw new Error(`No fallback config available for unknown type "${type}"`);
        systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras);
    }
    // When skills is string[], we've already preloaded them into the prompt.
    // Still pass noSkills: true since we don't need the skill loader to load them again.
    const noSkills = skills === false || Array.isArray(skills);
    const agentDir = getAgentDir();
    // Load extensions/skills: true or string[] → load; false → don't.
    // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
    // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
    // would defeat prompt_mode: replace and isolated: true. Parent context, if
    // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
    // is embedded in systemPromptOverride) or inherit_context (conversation).
    const loader = new DefaultResourceLoader({
        cwd: effectiveCwd,
        agentDir,
        noExtensions: extensions === false,
        noSkills,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => systemPrompt,
        appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    // Resolve model: explicit option > config.model > parent model
    const model = options.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig?.model);
    // Resolve thinking level: explicit option > agent config > undefined (inherit)
    const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;
    const sessionOpts = {
        cwd: effectiveCwd,
        agentDir,
        sessionManager: SessionManager.inMemory(effectiveCwd),
        settingsManager: SettingsManager.create(effectiveCwd, agentDir),
        modelRegistry: ctx.modelRegistry,
        model,
        tools: toolNames,
        resourceLoader: loader,
    };
    if (thinkingLevel) {
        sessionOpts.thinkingLevel = thinkingLevel;
    }
    const { session } = await createAgentSession(sessionOpts);
    // Build disallowed tools set from agent config
    const disallowedSet = agentConfig?.disallowedTools
        ? new Set(agentConfig.disallowedTools)
        : undefined;
    // Filter active tools: remove our own tools to prevent nesting,
    // apply extension allowlist if specified, and apply disallowedTools denylist
    if (extensions !== false) {
        const builtinToolNameSet = new Set(toolNames);
        const activeTools = session.getActiveToolNames().filter((t) => {
            if (EXCLUDED_TOOL_NAMES.includes(t) && !agentConfig?.allowNesting)
                return false;
            if (disallowedSet?.has(t))
                return false;
            if (builtinToolNameSet.has(t))
                return true;
            if (Array.isArray(extensions)) {
                return extensions.some(ext => t.startsWith(ext) || t.includes(ext));
            }
            return true;
        });
        session.setActiveToolsByName(activeTools);
    }
    else if (disallowedSet) {
        // Even with extensions disabled, apply denylist to built-in tools
        const activeTools = session.getActiveToolNames().filter(t => !disallowedSet.has(t));
        session.setActiveToolsByName(activeTools);
    }
    // Bind extensions so that session_start fires and extensions can initialize
    // (e.g. loading credentials, setting up state). Placed after tool filtering
    // so extension-provided skills/prompts from extendResourcesFromExtensions()
    // respect the active tool set. All ExtensionBindings fields are optional.
    await session.bindExtensions({
        onError: (err) => {
            options.onToolActivity?.({
                type: "end",
                toolName: `extension-error:${err.extensionPath}`,
            });
        },
    });
    options.onSessionCreated?.(session);
    // Track turns for graceful max_turns enforcement
    let turnCount = 0;
    const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
    let softLimitReached = false;
    let aborted = false;
    let currentMessageText = "";
    const unsubTurns = session.subscribe((event) => {
        if (event.type === "turn_end") {
            turnCount++;
            options.onTurnEnd?.(turnCount);
            if (maxTurns != null) {
                if (!softLimitReached && turnCount >= maxTurns) {
                    softLimitReached = true;
                    session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
                }
                else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
                    aborted = true;
                    session.abort();
                }
            }
        }
        if (event.type === "message_start") {
            currentMessageText = "";
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            currentMessageText += event.assistantMessageEvent.delta;
            options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
        }
        if (event.type === "tool_execution_start") {
            options.onToolActivity?.({ type: "start", toolName: event.toolName });
        }
        if (event.type === "tool_execution_end") {
            options.onToolActivity?.({ type: "end", toolName: event.toolName });
        }
    });
    const collector = collectResponseText(session);
    const cleanupAbort = forwardAbortSignal(session, options.signal);
    // Build the effective prompt: optionally prepend parent context
    let effectivePrompt = prompt;
    if (options.inheritContext) {
        const parentContext = buildParentContext(ctx);
        if (parentContext) {
            effectivePrompt = parentContext + prompt;
        }
    }
    try {
        await session.prompt(effectivePrompt);
    }
    finally {
        unsubTurns();
        collector.unsubscribe();
        cleanupAbort();
    }
    const responseText = collector.getText().trim() || getLastAssistantText(session);
    return { responseText, session, aborted, steered: softLimitReached };
}
/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(session, prompt, options = {}) {
    const collector = collectResponseText(session);
    const cleanupAbort = forwardAbortSignal(session, options.signal);
    const unsubToolUse = options.onToolActivity
        ? session.subscribe((event) => {
            if (event.type === "tool_execution_start")
                options.onToolActivity({ type: "start", toolName: event.toolName });
            if (event.type === "tool_execution_end")
                options.onToolActivity({ type: "end", toolName: event.toolName });
        })
        : () => { };
    try {
        await session.prompt(prompt);
    }
    finally {
        collector.unsubscribe();
        unsubToolUse();
        cleanupAbort();
    }
    return collector.getText().trim() || getLastAssistantText(session);
}
/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(session, message) {
    await session.steer(message);
}
/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session) {
    const parts = [];
    for (const msg of session.messages) {
        if (msg.role === "user") {
            const text = typeof msg.content === "string"
                ? msg.content
                : extractText(msg.content);
            if (text.trim())
                parts.push(`[User]: ${text.trim()}`);
        }
        else if (msg.role === "assistant") {
            const textParts = [];
            const toolCalls = [];
            for (const c of msg.content) {
                if (c.type === "text" && c.text)
                    textParts.push(c.text);
                else if (c.type === "toolCall")
                    toolCalls.push(`  Tool: ${c.name ?? c.toolName ?? "unknown"}`);
            }
            if (textParts.length > 0)
                parts.push(`[Assistant]: ${textParts.join("\n")}`);
            if (toolCalls.length > 0)
                parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
        }
        else if (msg.role === "toolResult") {
            const text = extractText(msg.content);
            const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
            parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
        }
    }
    return parts.join("\n\n");
}
