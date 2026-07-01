const WRITE_TOOL_NAMES = new Set(["write", "edit"]);

export interface SessionReviewScope {
  path: string;
  include: string[];
  exclude?: string[];
  notes?: string;
}

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : null;
}

function parseArguments(value: unknown): RecordLike | null {
  const record = asRecord(value);
  if (record) return record;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function stringField(record: RecordLike, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function cleanPath(path: string): string {
  return path.replace(/^@/, "").trim();
}

export function collectSessionWritePaths(entries: unknown[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const entry of entries) {
    const entryRecord = asRecord(entry);
    const message = asRecord(entryRecord?.message);
    const content = Array.isArray(message?.content) ? message.content : [];

    for (const block of content) {
      const blockRecord = asRecord(block);
      if (!blockRecord) continue;

      const name = stringField(blockRecord, ["name", "toolName"]);
      if (!name || !WRITE_TOOL_NAMES.has(name)) continue;

      const args = parseArguments(blockRecord.arguments) ?? parseArguments(blockRecord.input);
      if (!args) continue;

      const path = stringField(args, ["path", "filePath", "file_path"]);
      if (!path) continue;

      const cleaned = cleanPath(path);
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      paths.push(cleaned);
    }
  }

  return paths;
}

export function buildSessionScopePrompt(paths: string[], cwd: string): string {
  const hints = paths.length > 0 ? paths.map((path) => `- ${path}`).join("\n") : "- none observed";

  return [
    "Codex session review requested.",
    "",
    `Current cwd: ${cwd}`,
    "",
    "Observed write/edit paths from this session (hints only):",
    hints,
    "",
    "Choose actual review scope before running Codex:",
    "1. Treat observed paths as hints, not authority; bash commands may have changed other files.",
    "2. Inspect/confirm which repo(s) and paths belong in scope.",
    "3. Call codex_review_session_scope with repos[].path set to absolute git repo root and repos[].include set to confirmed paths.",
    "4. Keep scope narrow; include related files only when needed for correctness.",
    "5. Put intentionally skipped changed files in repos[].exclude with rationale in reason/notes.",
  ].join("\n");
}

export function buildScopedReviewPrompt(scope: SessionReviewScope, reason: string): string {
  const include = scope.include.length > 0 ? scope.include.map((path) => `- ${path}`).join("\n") : "- no included paths supplied";
  const exclude = scope.exclude && scope.exclude.length > 0
    ? scope.exclude.map((path) => `- ${path}`).join("\n")
    : "- none";
  const trimmedNotes = scope.notes?.trim();
  const trimmedReason = reason.trim();

  return [
    "Review only the confirmed session scope below.",
    "These paths are prompt scope, not CLI path filters; use other changed files only as context.",
    "",
    `Repo: ${scope.path}`,
    trimmedReason ? `Scope reason: ${trimmedReason}` : undefined,
    trimmedNotes ? `Scope notes: ${trimmedNotes}` : undefined,
    "",
    "Include:",
    include,
    "",
    "Exclude / ignore unless directly required for included scope:",
    exclude,
  ].filter((line): line is string => line !== undefined).join("\n");
}
