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
const MAX_SUGGESTIONS = 30
const SKILL_TOKEN_RE =
  /(^|[\s([{,])\$skill:([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-]|[:/])/gi
const SLASH_SKILL_CONTEXT_RE = /(?:^|[\s([{,])\$(?:skill:)?[a-z0-9-]*$/i

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

function extractSlashSkillPrefix(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/(?:^|[\s([{,])\$(?:skill:)?([a-z0-9-]*)$/i)
  return match?.[1]
}

function isPromptStartSlashToken(
  lines: string[],
  cursorLine: number,
  textBeforeCursor: string,
  prefix: string,
): boolean {
  const slashPrefixStart = textBeforeCursor.length - prefix.length - 1
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
  if (!/^[a-zA-Z0-9\-_$]$/.test(data)) return

  const currentLine = editor.state.lines[editor.state.cursorLine] ?? ""
  const textBeforeCursor = currentLine.slice(0, editor.state.cursorCol)
  if (SLASH_SKILL_CONTEXT_RE.test(textBeforeCursor)) {
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
      const query = extractSlashSkillPrefix(textBeforeCursor)
      if (query === undefined) {
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
      const skills = getSkills(pi)
      if (options.signal.aborted || skills.length === 0) {
        return currentSuggestions
      }

      const matches = query
        ? filterSkills(skills, query).slice(0, MAX_SUGGESTIONS)
        : skills.slice(0, MAX_SUGGESTIONS)

      if (matches.length === 0) return currentSuggestions

      const skillItems = matches.map((skill): AutocompleteItem => {
        const item: AutocompleteItem = {
          value: `$skill:${skill.name}`,
          label: `$skill:${skill.name}`,
        }
        const description = prefixAutocompleteDescription(skill)
        if (description) item.description = description
        return item
      })

      return mergeAutocompleteItems({
        current: currentSuggestions,
        skillItems,
        preferCommands: isPromptStartSlashToken(
          lines,
          cursorLine,
          textBeforeCursor,
          query,
        ),
        prefix: query,
      })
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = lines[cursorLine] ?? ""
      const prefixStart = cursorCol - prefix.length
      const beforePrefix =
        prefixStart >= 0 ? currentLine.slice(0, prefixStart) : ""
      const tokenMatch = beforePrefix.match(/\$(?:skill:)?$/i)
      const isSlashSkillCompletion =
        item.label.startsWith("$skill:") &&
        item.value.startsWith("$skill:") &&
        prefixStart >= 0 &&
        tokenMatch !== null

      if (!isSlashSkillCompletion || !tokenMatch) {
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
      // Consume any trailing skill-name characters so re-editing an existing
      // `$skill:<name>` token (cursor anywhere inside it) replaces the whole token.
      const afterCursor = currentLine.slice(cursorCol).replace(/^[a-z0-9-]*/i, "")
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
    loadedSkills = restoreLoadedSkills(ctx)
    ctx.ui.addAutocompleteProvider((current) =>
      createSlashSkillAutocompleteProvider(pi, current),
    )
  })

  pi.on("session_tree", async (_event, ctx) => {
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
    loadedSkills = restoreLoadedSkills(ctx)
    if (event.source === "extension" || !event.text.includes("$skill:")) {
      return { action: "continue" }
    }
    if (hasStartingCommandConflict(pi, event.text)) {
      return { action: "continue" }
    }

    const expanded = findInlineSkills(event.text, getSkills(pi))
    if (!expanded) return { action: "continue" }

    const skillsToInject = expanded.selected.filter(
      (skill) => !loadedSkills.has(skill.name),
    )

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

    return {
      action: "transform",
      text: event.text,
      ...(event.images ? { images: event.images } : {}),
    }
  })

  pi.on("before_agent_start", async () => {
    if (!pendingInlineSkillContent) return
    const content = pendingInlineSkillContent
    const names = pendingInlineSkillNames
    const skills = pendingInlineSkillBlocks
    pendingInlineSkillContent = undefined
    pendingInlineSkillNames = []
    pendingInlineSkillBlocks = []
    return {
      message: {
        customType: INLINE_SKILL_MESSAGE_TYPE,
        content,
        display: true,
        details: { names, skills },
      },
    }
  })
}
