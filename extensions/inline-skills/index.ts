import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  SkillInvocationMessageComponent,
  type ParsedSkillBlock,
} from "@earendil-works/pi-coding-agent"
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui"
import { compileInputSchema, type CompiledSchema } from "../subagents/src/graph/json-schema.js"
import { coerceGraphInput } from "../subagents/src/graph/run-graph.js"
import { listSavedGraphNames, resolveSavedGraph } from "../subagents/src/graph/saved-graph.js"

type AutocompleteItem = {
  value: string
  label: string
  description?: string
}

type AutocompleteSuggestions = {
  items: AutocompleteItem[]
  prefix: string
}

type AutocompleteProvider = {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number }
  shouldTriggerFileCompletion?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean
}

type SkillCommand = {
  name: string
  description?: string
  source: string
  sourceInfo: {
    path: string
    source: string
    scope: "user" | "project" | "temporary"
  }
}

type SkillInfo = {
  name: string
  description?: string
  sourceInfo?: SkillCommand["sourceInfo"]
}

type PendingGraphInvocation = {
  name: string
  originalPrompt: string
  description?: string
  inputSchema?: unknown
  inputValidator?: CompiledSchema
}

type LoadedSkillEntryData = {
  name?: string
  source?: "tool-result"
}

type InlineSkillMessageDetails = {
  names?: string[]
  skills?: ParsedSkillBlock[]
}

type InlineSkillSessionEntry = {
  type: string
  customType?: string
  data?: LoadedSkillEntryData
  details?: InlineSkillMessageDetails
}

const LOADED_SKILL_ENTRY_TYPE = "loaded-skill"
const INLINE_SKILL_MESSAGE_TYPE = "inline-skill"
const INLINE_GRAPH_MESSAGE_TYPE = "inline-graph-invocation"
const MAX_SUGGESTIONS = 30
const SKILL_TOKEN_RE =
  /(^|[\s([{,])\$skill:([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-]|[:/])/gi
const GRAPH_TOKEN_RE = /(^|[\s([{,])\$graph:([^\s)\]}>,"']*)/gi
const SLASH_TOKEN_CONTEXT_RE = /(?:^|[\s([{,])\$(?:(?:skill|graph):)?[a-z0-9._/-]*$/i

function fuzzyScore(value: string, query: string): number {
  const target = value.toLowerCase()
  const needle = query.toLowerCase()
  if (!needle) return 1
  if (target === needle) return 1000
  if (target.startsWith(needle)) return 800 - target.length
  if (target.includes(needle))
    return 600 - target.indexOf(needle) - target.length

  let score = 0
  let lastIndex = -1
  for (const char of needle) {
    const index = target.indexOf(char, lastIndex + 1)
    if (index === -1) return 0
    score += index === lastIndex + 1 ? 20 : 5
    lastIndex = index
  }
  return score - target.length
}

function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  return skills
    .map((skill) => ({ skill, score: fuzzyScore(skill.name, query) }))
    .filter((entry) => entry.score > 0)
    .toSorted(
      (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
    )
    .map((entry) => entry.skill)
}

function filterGraphNames(names: string[], query: string): string[] {
  return names
    .map((name) => ({ name, score: fuzzyScore(name, query) }))
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .map((entry) => entry.name)
}

function getAutocompleteSourceTag(
  sourceInfo: SkillCommand["sourceInfo"] | undefined,
): string | undefined {
  if (!sourceInfo) return undefined

  const scopePrefix =
    sourceInfo.scope === "user"
      ? "u"
      : sourceInfo.scope === "project"
        ? "p"
        : "t"
  const source = sourceInfo.source.trim()
  if (source === "auto" || source === "local" || source === "cli") {
    return scopePrefix
  }
  if (source.startsWith("npm:")) return `${scopePrefix}:${source}`
  return scopePrefix
}

function prefixAutocompleteDescription(skill: SkillInfo): string | undefined {
  const sourceTag = getAutocompleteSourceTag(skill.sourceInfo)
  if (!sourceTag) return skill.description
  return skill.description
    ? `[${sourceTag}] ${skill.description}`
    : `[${sourceTag}]`
}

function getSkills(pi: ExtensionAPI): SkillInfo[] {
  return (pi.getCommands() as SkillCommand[])
    .filter(
      (command) =>
        command.source === "skill" && command.name.startsWith("skill:"),
    )
    .map((command) => {
      const skill: SkillInfo = {
        name: command.name.slice("skill:".length),
        sourceInfo: command.sourceInfo,
      }
      if (command.description) skill.description = command.description
      return skill
    })
}

function hasStartingCommandConflict(pi: ExtensionAPI, text: string): boolean {
  const match = text.match(/^\/([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-]|[:/])/i)
  if (!match?.[1]) return false

  const name = match[1].toLowerCase()
  return (pi.getCommands() as SkillCommand[]).some(
    (command) =>
      command.source !== "skill" && command.name.toLowerCase() === name,
  )
}

function normalizePath(path: string, cwd: string): string {
  const absolutePath = path.startsWith("/") ? path : resolve(cwd, path)
  try {
    if (existsSync(absolutePath)) return realpathSync.native(absolutePath)
  } catch {
    // Fall back to the resolved path below.
  }
  return absolutePath
}

function getCurrentSkillPathMap(
  pi: ExtensionAPI,
  cwd: string,
): Map<string, string> {
  const skills = new Map<string, string>()

  for (const command of pi.getCommands() as SkillCommand[]) {
    if (command.source !== "skill") continue
    if (!command.name?.startsWith("skill:")) continue
    if (!command.sourceInfo?.path) continue

    skills.set(
      normalizePath(command.sourceInfo.path, cwd),
      command.name.slice("skill:".length),
    )
  }

  return skills
}

function restoreLoadedSkills(ctx: ExtensionContext): Set<string> {
  const loadedSkills = new Set<string>()

  for (const entry of ctx.sessionManager.getBranch() as InlineSkillSessionEntry[]) {
    if (
      entry.type === "custom" &&
      entry.customType === LOADED_SKILL_ENTRY_TYPE
    ) {
      const data = entry.data
      if (
        data?.source === "tool-result" &&
        typeof data.name === "string" &&
        data.name.trim()
      ) {
        loadedSkills.add(data.name)
      }
      continue
    }

    if (
      entry.type === "custom_message" &&
      entry.customType === INLINE_SKILL_MESSAGE_TYPE
    ) {
      for (const skill of entry.details?.skills ?? []) {
        if (skill.name.trim()) loadedSkills.add(skill.name)
      }
    }
  }

  return loadedSkills
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content

  const end = content.indexOf("\n---", 3)
  if (end === -1) return content

  const afterEnd = content.indexOf("\n", end + 4)
  return afterEnd === -1 ? "" : content.slice(afterEnd + 1)
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function buildSkillBlock(
  skill: SkillInfo,
  cwd: string,
): { text: string; skillBlock: ParsedSkillBlock } {
  const skillPath = skill.sourceInfo?.path
  if (!skillPath) {
    throw new Error(`missing path for skill ${skill.name}`)
  }

  const normalizedPath = normalizePath(skillPath, cwd)
  const content = readFileSync(normalizedPath, "utf-8")
  const body = stripFrontmatter(content).trim()
  const skillContent = `References are relative to ${dirname(normalizedPath)}.\n\n${body}`
  return {
    text: `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(normalizedPath)}">\n${skillContent}\n</skill>`,
    skillBlock: {
      name: skill.name,
      location: normalizedPath,
      content: skillContent,
      userMessage: undefined,
    },
  }
}

function buildInlineSkillContent(
  skills: SkillInfo[],
  cwd: string,
): { content: string; skillBlocks: ParsedSkillBlock[] } {
  const skillBlocks = skills.map((skill) => buildSkillBlock(skill, cwd))
  const blocks = skillBlocks.map((skill) => skill.text).join("\n\n")
  return {
    content: `<inline_skills>\nThe following inline skill contents are already loaded. Do not load them again unless the user asks to inspect the source file.\n\n${blocks}\n</inline_skills>`,
    skillBlocks: skillBlocks.map((skill) => skill.skillBlock),
  }
}

function findInlineSkills(
  text: string,
  skills: SkillInfo[],
): { selected: SkillInfo[] } | undefined {
  const byName = new Map(
    skills.map((skill) => [skill.name.toLowerCase(), skill]),
  )
  const selected: SkillInfo[] = []
  const seen = new Set<string>()

  text.replace(
    SKILL_TOKEN_RE,
    (match, _boundary: string, skillName: string) => {
      const skill = byName.get(skillName.toLowerCase())
      if (!skill) return match
      if (!seen.has(skill.name)) {
        seen.add(skill.name)
        selected.push(skill)
      }
      return match
    },
  )

  if (selected.length === 0) return undefined

  return { selected }
}

function findGraphTokenNames(text: string): string[] {
  return [...text.matchAll(GRAPH_TOKEN_RE)].map((match) => match[2] ?? "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createGraphInvocation(
  name: string,
  originalPrompt: string,
  cwd: string,
): PendingGraphInvocation | { error: string } {
  const resolved = resolveSavedGraph(name, cwd)
  if (!resolved.ok) return { error: resolved.message }
  const graph = isRecord(resolved.graph) ? resolved.graph : {}
  const inputSchema = graph.inputSchema
  let inputValidator: CompiledSchema | undefined
  if (inputSchema !== undefined) {
    const compiled = compileInputSchema(inputSchema)
    if (!compiled.ok) return { error: `Graph "${name}" has an invalid inputSchema: ${compiled.message}` }
    inputValidator = compiled.compiled
  }
  return {
    name,
    originalPrompt,
    ...(typeof graph.description === "string" ? { description: graph.description } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(inputValidator ? { inputValidator } : {}),
  }
}

function graphContextJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

function buildGraphInvocationContent(invocation: PendingGraphInvocation): string {
  const description = invocation.description === undefined
    ? ""
    : `\n<saved_graph_description_json>${graphContextJson(invocation.description)}</saved_graph_description_json>`
  const inputSchema = invocation.inputSchema === undefined
    ? ""
    : `\n<saved_graph_input_schema_json>${graphContextJson(invocation.inputSchema)}</saved_graph_input_schema_json>`
  return `<saved_graph_invocation>\n<selected_saved_graph>${invocation.name}</selected_saved_graph>${description}${inputSchema}\n<original_user_prompt_json>${graphContextJson(invocation.originalPrompt)}</original_user_prompt_json>\n<instructions>User explicitly authorized only selected_saved_graph. Declared nested subgraphs run internally through executor preflight. Decode original_user_prompt_json and construct agent_graph.input to satisfy saved_graph_input_schema_json when present, inferring/mapping values from the full request. Ask the user only when required values cannot be inferred. Call existing agent_graph with selected_saved_graph; do not use inline, nested, or unrelated graphs.</instructions>\n</saved_graph_invocation>`
}

type SlashTokenPrefix = {
  kind: "all" | "skill" | "graph"
  query: string
}

function extractSlashTokenPrefix(textBeforeCursor: string): SlashTokenPrefix | undefined {
  const match = textBeforeCursor.match(/(?:^|[\s([{,])\$(?:(skill|graph):)?([a-z0-9._/-]*)$/i)
  if (!match) return undefined
  const kind = match[1]?.toLowerCase()
  return {
    kind: kind === "skill" || kind === "graph" ? kind : "all",
    query: match[2] ?? "",
  }
}

function isPromptStartSlashToken(
  lines: string[],
  cursorLine: number,
  textBeforeCursor: string,
  prefix: SlashTokenPrefix,
): boolean {
  const tokenPrefixLength = prefix.kind === "all" ? 1 : prefix.kind.length + 2
  const slashPrefixStart = textBeforeCursor.length - prefix.query.length - tokenPrefixLength
  if (slashPrefixStart < 0) return false
  const earlierLinesAreBlank = lines
    .slice(0, cursorLine)
    .every((line) => line.trim().length === 0)
  return (
    earlierLinesAreBlank &&
    textBeforeCursor.slice(0, slashPrefixStart).trim() === ""
  )
}

function mergeAutocompleteItems(options: {
  current: AutocompleteSuggestions | null
  skillItems: AutocompleteItem[]
  preferCommands: boolean
  prefix: string
}): AutocompleteSuggestions {
  const currentItems = options.current?.items ?? []
  const orderedItems = options.preferCommands
    ? [...currentItems, ...options.skillItems]
    : [...options.skillItems, ...currentItems]
  const seen = new Set<string>()
  const items = orderedItems.filter((item) => {
    const key = `${item.label}\u0000${item.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return {
    prefix: options.prefix,
    items: items.slice(0, MAX_SUGGESTIONS),
  }
}

type SlashTriggerEditor = {
  isShowingAutocomplete?: () => boolean
  state?: { cursorLine: number; cursorCol: number; lines: string[] }
  tryTriggerAutocomplete?: () => void
}

function runSlashAutocompleteTrigger(
  editor: SlashTriggerEditor,
  data: string,
): void {
  if (
    editor.isShowingAutocomplete?.() ||
    !editor.state ||
    typeof editor.tryTriggerAutocomplete !== "function"
  )
    return
  if (!/^[a-zA-Z0-9._:/\-_$]$/.test(data)) return

  const currentLine = editor.state.lines[editor.state.cursorLine] ?? ""
  const textBeforeCursor = currentLine.slice(0, editor.state.cursorCol)
  if (SLASH_TOKEN_CONTEXT_RE.test(textBeforeCursor)) {
    editor.tryTriggerAutocomplete()
  }
}

function installSlashAutocompleteTrigger(): void {
  const proto = CustomEditor.prototype as unknown as {
    handleInput(data: string): void
    inlineSkillsSlashTriggerInstalled?: boolean
    inlineSkillsSlashTrigger?: (editor: SlashTriggerEditor, data: string) => void
  }

  // Refresh the trigger implementation on every load so `/reload` (which re-runs
  // extensions in-process) picks up the current logic. The prototype wrapper is
  // installed only once (guarded below); without this indirection a reload would
  // keep the first-loaded trigger and, e.g., ignore the `$` delimiter.
  proto.inlineSkillsSlashTrigger = runSlashAutocompleteTrigger

  if (proto.inlineSkillsSlashTriggerInstalled) return

  const originalHandleInput = proto.handleInput
  proto.handleInput = function patchedHandleInput(
    this: unknown,
    data: string,
  ): void {
    originalHandleInput.call(this, data)
    proto.inlineSkillsSlashTrigger?.(this as SlashTriggerEditor, data)
  }
  proto.inlineSkillsSlashTriggerInstalled = true
}

function stripNativeSkillItems(
  suggestions: AutocompleteSuggestions | null,
): AutocompleteSuggestions | null {
  if (!suggestions) return suggestions
  return {
    ...suggestions,
    items: suggestions.items.filter(
      (item) => !item.label.startsWith("skill:"),
    ),
  }
}

function createSlashSkillAutocompleteProvider(
  pi: ExtensionAPI,
  cwd: string,
  current: AutocompleteProvider,
): AutocompleteProvider {
  return {
    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? ""
      const textBeforeCursor = currentLine.slice(0, cursorCol)
      const prefix = extractSlashTokenPrefix(textBeforeCursor)
      if (prefix === undefined) {
        const deferred = await current.getSuggestions(
          lines,
          cursorLine,
          cursorCol,
          options,
        )
        return stripNativeSkillItems(deferred)
      }

      const currentSuggestions = await current.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      )
      if (options.signal.aborted) return currentSuggestions

      const skillItems = prefix.kind === "graph"
        ? []
        : (prefix.query
          ? filterSkills(getSkills(pi), prefix.query)
          : getSkills(pi))
            .slice(0, MAX_SUGGESTIONS)
            .map((skill): AutocompleteItem => {
              const item: AutocompleteItem = {
                value: `$skill:${skill.name}`,
                label: `$skill:${skill.name}`,
              }
              const description = prefixAutocompleteDescription(skill)
              if (description) item.description = description
              return item
            })
      const graphItems = prefix.kind === "skill" || !pi.getActiveTools().includes("agent_graph")
        ? []
        : (prefix.query
          ? filterGraphNames(listSavedGraphNames(cwd), prefix.query)
          : listSavedGraphNames(cwd))
            .slice(0, MAX_SUGGESTIONS)
            .map((name): AutocompleteItem => ({
              value: `$graph:${name}`,
              label: `$graph:${name}`,
            }))
      const tokenItems = [...skillItems, ...graphItems]
      if (tokenItems.length === 0) return currentSuggestions

      return mergeAutocompleteItems({
        current: currentSuggestions,
        skillItems: tokenItems,
        preferCommands: isPromptStartSlashToken(
          lines,
          cursorLine,
          textBeforeCursor,
          prefix,
        ),
        prefix: prefix.query,
      })
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = lines[cursorLine] ?? ""
      const prefixStart = cursorCol - prefix.length
      const beforePrefix =
        prefixStart >= 0 ? currentLine.slice(0, prefixStart) : ""
      const tokenMatch = beforePrefix.match(/\$(?:(?:skill|graph):)?$/i)
      const isSlashTokenCompletion =
        (item.label.startsWith("$skill:") || item.label.startsWith("$graph:")) &&
        (item.value.startsWith("$skill:") || item.value.startsWith("$graph:")) &&
        prefixStart >= 0 &&
        tokenMatch !== null

      if (!isSlashTokenCompletion || !tokenMatch) {
        return current.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix,
        )
      }

      const tokenStart = beforePrefix.length - tokenMatch[0].length
      const beforeToken = currentLine.slice(0, tokenStart)
      const afterCursor = currentLine.slice(cursorCol).replace(/^[a-z0-9._/-]*/i, "")
      const suffix = afterCursor.startsWith(" ") ? "" : " "
      const nextLines = [...lines]
      nextLines[cursorLine] =
        `${beforeToken}${item.value}${suffix}${afterCursor}`
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforeToken.length + item.value.length + suffix.length,
      }
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      )
    },
  }
}

export default function (pi: ExtensionAPI): void {
  let pendingInlineSkillContent: string | undefined
  let pendingInlineSkillNames: string[] = []
  let pendingInlineSkillBlocks: ParsedSkillBlock[] = []
  let pendingGraphInvocation: PendingGraphInvocation | undefined
  let activeGraphAuthorization: {
    sessionId: string
    name: string
    state: "unused" | "clarifying" | "consumed"
    inputValidator?: CompiledSchema
  } | undefined
  let loadedSkills = new Set<string>()

  installSlashAutocompleteTrigger()

  pi.registerMessageRenderer(
    INLINE_SKILL_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = message.details as InlineSkillMessageDetails | undefined
      const names = details?.names?.length ? details.names.join(", ") : "skill"
      const label = theme.fg(
        "customMessageLabel",
        `\x1b[1m[${INLINE_SKILL_MESSAGE_TYPE}]\x1b[22m`,
      )

      if (details?.skills?.length) {
        const container = new Container()
        let first = true
        for (const skill of details.skills) {
          if (!first) container.addChild(new Spacer(1))
          first = false
          const component = new SkillInvocationMessageComponent(skill)
          component.setExpanded(expanded)
          container.addChild(component)
        }
        return container
      }

      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text))
      box.addChild(
        new Text(
          `${label} ${theme.fg("customMessageText", names)}${theme.fg("dim", " (ctrl+o to expand)")}`,
          0,
          0,
        ),
      )
      return box
    },
  )

  pi.registerCommand("loaded-skills", {
    description: "List skills loaded in this session",
    handler: async (_args, ctx) => {
      const names = [...restoreLoadedSkills(ctx)].toSorted((a, b) =>
        a.localeCompare(b),
      )

      if (names.length === 0) {
        ctx.ui.notify("No skills loaded yet", "info")
        return
      }
      ctx.ui.notify(`Loaded skills: ${names.join(", ")}`, "info")
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    activeGraphAuthorization = undefined
    loadedSkills = restoreLoadedSkills(ctx)
    ctx.ui.addAutocompleteProvider((current) =>
      createSlashSkillAutocompleteProvider(pi, ctx.cwd, current),
    )
  })

  pi.on("session_tree", async (_event, ctx) => {
    activeGraphAuthorization = undefined
    loadedSkills = restoreLoadedSkills(ctx)
  })

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) return

    const input = event.input as { path?: unknown }
    if (typeof input.path !== "string") return

    const readPath = normalizePath(input.path, ctx.cwd)
    const skillName = getCurrentSkillPathMap(pi, ctx.cwd).get(readPath)
    if (!skillName || loadedSkills.has(skillName)) return

    loadedSkills.add(skillName)
    pi.appendEntry(LOADED_SKILL_ENTRY_TYPE, {
      name: skillName,
      source: "tool-result",
    })
  })

  pi.on("input", async (event, ctx) => {
    pendingInlineSkillContent = undefined
    pendingInlineSkillNames = []
    pendingInlineSkillBlocks = []
    pendingGraphInvocation = undefined
    loadedSkills = restoreLoadedSkills(ctx)
    if (event.source === "extension") return { action: "continue" }

    const sessionId = ctx.sessionManager.getSessionId()
    const graphTokenNames = findGraphTokenNames(event.text)
    if (graphTokenNames.length > 0) {
      // A new graph request, even an invalid one, must not retain prior authority.
      activeGraphAuthorization = undefined
    } else if (activeGraphAuthorization?.sessionId !== sessionId) {
      activeGraphAuthorization = undefined
    } else if (activeGraphAuthorization?.state === "consumed") {
      // The next ordinary user input ends a consumed graph invocation.
      activeGraphAuthorization = undefined
    } else if (activeGraphAuthorization?.state === "unused") {
      // This user input is the sole clarification turn for an unused token.
      activeGraphAuthorization.state = "clarifying"
    } else if (activeGraphAuthorization?.state === "clarifying") {
      activeGraphAuthorization = undefined
    }

    if (!event.text.includes("$skill:") && graphTokenNames.length === 0) {
      return { action: "continue" }
    }
    if (hasStartingCommandConflict(pi, event.text)) {
      return { action: "continue" }
    }

    if (graphTokenNames.length > 0) {
      const selectedNames = [...new Set(graphTokenNames)]
      if (selectedNames.length > 1) {
        ctx.ui.notify(
          `inline-skills: multiple saved graph tokens are not allowed: ${selectedNames.join(", ")}`,
          "error",
        )
        return { action: "handled" }
      }
      if (!pi.getActiveTools().includes("agent_graph")) {
        ctx.ui.notify("inline-skills: saved graph support is disabled in this session.", "error")
        return { action: "handled" }
      }
      const invocation = createGraphInvocation(selectedNames[0], event.text, ctx.cwd)
      if ("error" in invocation) {
        ctx.ui.notify(`inline-skills: ${invocation.error}`, "error")
        return { action: "handled" }
      }
      pendingGraphInvocation = invocation
      activeGraphAuthorization = {
        sessionId,
        name: invocation.name,
        state: "unused",
        ...(invocation.inputValidator ? { inputValidator: invocation.inputValidator } : {}),
      }
    }

    const expanded = findInlineSkills(event.text, getSkills(pi))
    const skillsToInject = expanded?.selected.filter(
      (skill) => !loadedSkills.has(skill.name),
    ) ?? []
    if (skillsToInject.length > 0) {
      try {
        const inlineSkillContent = buildInlineSkillContent(
          skillsToInject,
          ctx.cwd,
        )
        pendingInlineSkillContent = inlineSkillContent.content
        pendingInlineSkillBlocks = inlineSkillContent.skillBlocks
        pendingInlineSkillNames = skillsToInject.map((skill) => skill.name)
        for (const skill of skillsToInject) {
          loadedSkills.add(skill.name)
        }
      } catch (error) {
        pendingInlineSkillContent = undefined
        pendingInlineSkillNames = []
        pendingInlineSkillBlocks = []
        ctx.ui.notify(
          `inline-skills: failed to load skill: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        )
      }
    }

    if (!pendingGraphInvocation && !expanded) return { action: "continue" }
    return {
      action: "transform",
      text: event.text,
      ...(event.images ? { images: event.images } : {}),
    }
  })

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "agent_graph" || !activeGraphAuthorization) return
    if (activeGraphAuthorization.sessionId !== ctx.sessionManager.getSessionId()) {
      activeGraphAuthorization = undefined
      return
    }
    const toolInput = isRecord(event.input) ? event.input : {}
    const graph = toolInput.graph
    if (
      activeGraphAuthorization.state !== "consumed" &&
      typeof graph === "string" &&
      graph === activeGraphAuthorization.name
    ) {
      const validation = activeGraphAuthorization.inputValidator?.check(
        coerceGraphInput(toolInput.input),
      )
      if (validation !== undefined && validation !== true) {
        return {
          block: true,
          reason: `agent_graph input does not satisfy the selected saved graph schema: ${validation}`,
        }
      }
      activeGraphAuthorization.state = "consumed"
      return
    }
    return {
      block: true,
      reason: activeGraphAuthorization.state === "consumed"
        ? "agent_graph authorization was already consumed."
        : "agent_graph is authorized only for the selected saved graph.",
    }
  })

  pi.on("agent_end", async () => {
    if (activeGraphAuthorization?.state === "clarifying") {
      activeGraphAuthorization = undefined
    }
  })

  pi.on("before_agent_start", async () => {
    if (!pendingInlineSkillContent && !pendingGraphInvocation) return
    const skills = pendingInlineSkillBlocks
    const names = pendingInlineSkillNames
    const graphInvocation = pendingGraphInvocation
    const content = [
      pendingInlineSkillContent,
      graphInvocation ? buildGraphInvocationContent(graphInvocation) : undefined,
    ].filter((part): part is string => part !== undefined).join("\n\n")
    pendingInlineSkillContent = undefined
    pendingInlineSkillNames = []
    pendingInlineSkillBlocks = []
    pendingGraphInvocation = undefined
    return {
      message: {
        customType: skills.length > 0 ? INLINE_SKILL_MESSAGE_TYPE : INLINE_GRAPH_MESSAGE_TYPE,
        content,
        display: skills.length > 0,
        ...(skills.length > 0 ? { details: { names, skills } } : {}),
      },
    }
  })
}
