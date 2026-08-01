import { homedir } from "node:os";

export type AgentSession = any;
export type AgentSessionEvent = any;
export type ExtensionAPI = any;
export type ExtensionCommandContext = any;
export type ExtensionContext = any;
export type SessionEntry = any;
export type ToolInfo = {
  name: string;
  description?: string;
};

export class BorderedLoader {
  signal = undefined;
  onAbort = undefined;

  constructor(..._args: unknown[]) {}
}

export class CustomEditor {
  constructor(..._args: unknown[]) {}

  handleInput(_data: string): void {}

  getText(): string {
    return "";
  }
}

export class SkillInvocationMessageComponent {
  constructor(..._args: unknown[]) {}

  setExpanded(_expanded: boolean): void {}
}

export class DynamicBorder {
  constructor(..._args: unknown[]) {}
}

export class DefaultResourceLoader {}

export class SessionManager {}

export class SettingsManager {}

export const VERSION = "0.0.0-test";

export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export function buildSessionContext() {
  return { messages: [] };
}

export function convertToLlm<T>(value: T): T {
  return value;
}

export function createAgentSession() {
  return {};
}

export function createCodingTools() {
  return ["read", "bash", "edit", "write"].map((name) => ({ name }));
}

export function createReadOnlyTools() {
  return ["read", "grep", "find", "ls"].map((name) => ({ name }));
}

export function defineTool<T>(definition: T): T {
  return definition;
}

const fileMutationQueues = new Map<string, Promise<void>>();

export function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileMutationQueues.get(filePath) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const tail = result.then(() => undefined, () => undefined);
  fileMutationQueues.set(filePath, tail);
  void tail.finally(() => {
    if (fileMutationQueues.get(filePath) === tail) fileMutationQueues.delete(filePath);
  });
  return result;
}

export function createBashTool() {
  return {};
}


export function createBashToolDefinition(_cwd?: string) {
  return {
    name: "bash",
    label: "bash",
    description: "Execute a bash command",
    parameters: {},
    renderCall: () => ({ text: "bash" }),
    renderResult: () => ({ text: "" }),
    async execute() {
      return { content: [{ type: "text", text: "" }], details: {} };
    }
  };
}
export function createEditTool() {
  return {};
}

export function createFindTool() {
  return {};
}

export function createGrepTool() {
  return {};
}

export function createLocalBashOperations() {
  return {
    exec(command: string, cwd?: string, options?: Record<string, unknown>) {
      return { command, cwd, options };
    }
  };
}

export function createLsTool() {
  return {};
}

export function createReadTool() {
  return {};
}

export function createWriteTool() {
  return {};
}

export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;
  return `${homedir()}/.pi/agent`;
}

export function getMarkdownTheme() {
  return {
    bold(text: string) {
      return text;
    },
    dim(text: string) {
      return text;
    },
    fg(_color: string, text: string) {
      return text;
    },
    strikethrough(text: string) {
      return text;
    }
  };
}

export function getSettingsListTheme() {
  return {
    selectedPrefix: ">",
    unselectedPrefix: " "
  };
}

// Minimal faithful port of @earendil-works/pi-coding-agent theme.initTheme:
// stores a global theme instance under the shared globalThis symbol keys so
// any consumer reading the `theme` proxy resolves instead of throwing.
export function initTheme(_themeName?: string, _enableWatcher = false): void {
  const themeInstance = {
    fg(_color: string, text: string): string {
      return text;
    },
    bold(text: string): string {
      return text;
    },
    dim(text: string): string {
      return text;
    },
  };
  const g = globalThis as Record<symbol, unknown>;
  g[Symbol.for("@earendil-works/pi-coding-agent:theme")] = themeInstance;
  g[Symbol.for("@mariozechner/pi-coding-agent:theme")] = themeInstance;
}

export function keyHint(_keybinding: string, description?: string): string {
  return description ? `${_keybinding} ${description}` : _keybinding;
}

export function keyText(text: string): string {
  return text;
}

export function isToolCallEventType(name: string, event: unknown): boolean {
  return Boolean(event && typeof event === "object" && (event as { toolName?: string }).toolName === name);
}

function coerceYamlValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(source: string): { frontmatter: T; body: string } {
  if (!source.startsWith("---\n")) {
    return { frontmatter: {} as T, body: source };
  }

  const end = source.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {} as T, body: source };
  }

  const yamlString = source.slice(4, end);
  const body = source.slice(end + 4).replace(/^\n/, "").trimEnd();

  if (!yamlString.trim()) {
    return { frontmatter: {} as T, body: body.trimStart() };
  }

  const raw = yamlString.split("\n");
  const frontmatter: Record<string, unknown> = {};
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;
    if (value === "") {
      // YAML block list: subsequent indented "- item" lines belong to this key.
      const items: string[] = [];
      let j = i + 1;
      while (j < raw.length && /^\s*-\s+/.test(raw[j])) {
        items.push(raw[j].replace(/^\s*-\s+/, "").trim());
        j++;
      }
      if (items.length > 0) {
        frontmatter[key] = items;
        i = j - 1;
        continue;
      }
      frontmatter[key] = coerceYamlValue(value);
      continue;
    }
    // Inline YAML list: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      frontmatter[key] = inner
        ? inner.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
        : [];
      continue;
    }
    frontmatter[key] = coerceYamlValue(value);
  }

  return {
    frontmatter: frontmatter as T,
    body
  };
}

export function serializeConversation(messages: unknown): string {
  return JSON.stringify(messages);
}

export function rawKeyHint(text: string): string {
  return text;
}
