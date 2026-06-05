import { Type } from "typebox";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { parseModelChain, resolveFirstAvailable } from "../lib/model.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const VISION_MODEL_CHAIN = [
  "gpt-5.5:medium",
  "mimo-v2.5",
  "kimi-k2.6",
  "glm-4.6v",
  "gpt-5-nano",
].join(",");

/** Sessions already warned about look_at falling back to the current agent model. */
const FALLBACK_WARNED_SESSIONS = new Set<string>();

type LookAtParams = {
  file_path?: string;
  image_data?: string;
  goal?: string;
  mime_type?: string;
};

type NormalizedLookAtParams = {
  file_path?: string;
  image_data?: string;
  goal: string;
  mime_type?: string;
};

type PreparedImage = ImageContent & {
  bytes: number;
  source: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`look_at ${name} must be a non-empty string.`);
  return value.trim();
}

function normalizeParams(params: unknown): NormalizedLookAtParams {
  if (!isRecord(params))
    throw new Error("look_at parameters must be an object.");
  const filePath =
    typeof params.file_path === "string" && params.file_path.trim()
      ? params.file_path.trim()
      : undefined;
  const imageData =
    typeof params.image_data === "string" && params.image_data.trim()
      ? params.image_data.trim()
      : undefined;
  if (Boolean(filePath) === Boolean(imageData)) {
    throw new Error("look_at requires exactly one of file_path or image_data.");
  }
  return {
    file_path: filePath,
    image_data: imageData,
    goal: assertString(params.goal, "goal"),
    mime_type:
      typeof params.mime_type === "string" && params.mime_type.trim()
        ? params.mime_type.trim()
        : undefined,
  };
}

function mimeFromPath(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return undefined;
  }
}

function assertSupportedMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (!SUPPORTED_MIME_TYPES.has(normalized)) {
    throw new Error(
      `look_at unsupported mime_type "${mimeType}". Supported: ${Array.from(SUPPORTED_MIME_TYPES).join(", ")}.`,
    );
  }
  return normalized;
}

function assertByteLimit(buffer: Buffer): void {
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `look_at image exceeds max size (${buffer.byteLength} > ${MAX_IMAGE_BYTES} bytes).`,
    );
  }
}

function resolveUnderCwd(cwd: string, inputPath: string): string {
  const stripped = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  const absolute = resolve(cwd, stripped);
  const rel = relative(cwd, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      "look_at file_path must resolve under cwd. If the image is elsewhere, copy it into cwd first (e.g., cp /path ./img.png), then use the relative path.",
    );
  }
  return absolute;
}

async function prepareFileImage(
  filePath: string,
  ctx: ExtensionContext,
): Promise<PreparedImage> {
  const absolutePath = resolveUnderCwd(ctx.cwd, filePath);
  const mimeType = assertSupportedMime(mimeFromPath(absolutePath) ?? "");
  const buffer = await readFile(absolutePath);
  assertByteLimit(buffer);
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType,
    bytes: buffer.byteLength,
    source: filePath,
  };
}

function decodeBase64Image(
  imageData: string,
  fallbackMimeType?: string,
): PreparedImage {
  let mimeType = fallbackMimeType;
  let base64 = imageData;
  const match = imageData.match(/^data:([^;,]+);base64,(.*)$/s);
  if (match) {
    mimeType = match[1];
    base64 = match[2];
  }
  mimeType = assertSupportedMime(mimeType ?? "image/png");
  base64 = base64.replace(/\s+/g, "");
  const buffer = Buffer.from(base64, "base64");
  if (
    buffer.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")
  ) {
    throw new Error(
      "look_at image_data must be valid base64 or a base64 data URI.",
    );
  }
  assertByteLimit(buffer);
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType,
    bytes: buffer.byteLength,
    source: "image_data",
  };
}

async function prepareImage(
  params: NormalizedLookAtParams,
  ctx: ExtensionContext,
): Promise<PreparedImage> {
  if (params.file_path) return prepareFileImage(params.file_path, ctx);
  return decodeBase64Image(params.image_data ?? "", params.mime_type);
}

function collectResponseText(session: AgentSession): {
  getText: () => string;
  unsubscribe: () => void;
} {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") text = "";
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (message.role !== "assistant") continue;
    const text = extractText(message.content).trim();
    if (text) return text;
  }
  return "";
}

function buildPrompt(goal: string): string {
  return `You are a precise multimodal inspection helper. Analyze the attached image for this goal only:\n\n${goal}\n\nReturn concise, factual findings. No preamble. If the image lacks enough evidence, say exactly what is missing.`;
}

async function runVisionInspection(
  ctx: ExtensionContext,
  image: ImageContent,
  goal: string,
  signal?: AbortSignal,
) {
  let resolved = resolveFirstAvailable(
    parseModelChain(VISION_MODEL_CHAIN),
    ctx.modelRegistry,
  );
  let fallback = false;

  if (!resolved) {
    const current = ctx.model;
    if (current && current.input.includes("image")) {
      resolved = { model: current, thinkingLevel: undefined };
      fallback = true;
      const sid = ctx.sessionManager.getSessionId();
      if (!FALLBACK_WARNED_SESSIONS.has(sid)) {
        FALLBACK_WARNED_SESSIONS.add(sid);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `look_at: no dedicated vision model in profile; using current model ${current.provider}/${current.id}`,
            "warning",
          );
        }
      }
    } else {
      const currentName = current
        ? `${current.provider}/${current.id}`
        : "none";
      throw new Error(
        `look_at could not find an available vision model for the active profile, and the current model (${currentName}) does not support image input.`,
      );
    }
  }

  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () =>
      "You inspect image attachments and answer with concise factual text only.",
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir,
    modelRegistry: ctx.modelRegistry,
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    settingsManager: SettingsManager.create(ctx.cwd, agentDir),
    noTools: "all",
  });

  const collector = collectResponseText(session);
  const abort = () => session.abort();
  try {
    signal?.addEventListener("abort", abort, { once: true });
    await session.prompt(buildPrompt(goal), {
      images: [image],
      expandPromptTemplates: false,
    });
    const text =
      collector.getText().trim() || getLastAssistantText(session).trim();
    if (!text) throw new Error("look_at vision model returned no text.");
    return {
      text,
      model: `${resolved.model.provider}/${resolved.model.id}`,
      thinkingLevel: resolved.thinkingLevel,
      fallback,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    collector.unsubscribe();
    session.dispose();
  }
}

export default function multimodalLook(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "look_at",
    label: "Look At",
    description:
      "Inspect a local image or base64 image with a dedicated profile-aware vision model and return concise text findings.",
    promptSnippet:
      "Use look_at when image understanding needs reliable vision-model analysis instead of relying on the current main model. If the image is outside cwd, copy it into cwd first.",
    promptGuidelines: [
      "Use look_at for screenshots, diagrams, photos, UI captures, charts, or visual artifacts when the answer depends on image contents.",
      "Provide a specific goal; look_at returns text evidence for the main agent to use.",
      "Do not use look_at for rendering or converting visuals; use render-visual for preview/render tasks.",
      "If the user references an image outside the current working directory, copy it into cwd first (e.g., cp /path ./img.png), then call look_at with the relative path.",
    ],
    parameters: Type.Object({
      file_path: Type.Optional(
        Type.String({
          description:
            "Path relative to the current working directory to an image file. Leading @ is stripped. If the image is elsewhere, copy it into cwd first.",
        }),
      ),
      image_data: Type.Optional(
        Type.String({
          description: "Base64 image data or data:image/...;base64,... URI.",
        }),
      ),
      mime_type: Type.Optional(
        Type.String({
          description:
            "MIME type for bare base64 image_data. Default: image/png.",
        }),
      ),
      goal: Type.String({
        description: "Specific visual question or extraction goal.",
      }),
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const normalized = normalizeParams(params);
      const image = await prepareImage(normalized, ctx);
      const result = await runVisionInspection(
        ctx,
        image,
        normalized.goal,
        signal,
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          model: result.model,
          thinkingLevel: result.thinkingLevel,
          mimeType: image.mimeType,
          bytes: image.bytes,
          source: image.source,
          fallback: result.fallback,
        },
      };
    },
  } as any);
}
