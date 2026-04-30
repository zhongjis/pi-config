/**
 * Tests for clauderock/index.ts — model fallback logic
 *
 * Covers:
 *   - Model ID mapping (Anthropic ↔ Bedrock normalization)
 *   - isQuotaError detection via event stream (error.errorMessage keywords)
 *   - isOauthRateLimitFallback detection via event stream
 *   - Thrown-error detection (status codes + message keywords)
 *   - Happy path: Anthropic succeeds, events forwarded correctly
 *   - pendingStart buffering and flushing
 *   - Fallback triggered via event stream → Bedrock
 *   - Fallback triggered via thrown error → Bedrock
 *   - No Bedrock mapping on quota/rate-limit error
 *   - Error after content already started → no fallback
 *   - Fallback already active (from persisted cache)
 *   - Bedrock model construction (id, provider, api)
 *   - streamViaBedrock: top-level model/message.model patching, partial unchanged
 *   - streamViaBedrock: Bedrock error wrapping
 *   - Notification queuing (quota_exhausted vs using_cached_fallback)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockContext } from "../../test/fixtures/mock-context.js";
import { createMockPi } from "../../test/fixtures/mock-pi.js";

// ---------------------------------------------------------------------------
// Pushable async stream — faithful mock of AssistantMessageEventStream
// ---------------------------------------------------------------------------
function makePushableStream() {
  const queue: any[] = [];
  let done = false;
  let notify: (() => void) | null = null;

  return {
    push(event: any) {
      queue.push(event);
      if (notify) {
        const fn = notify;
        notify = null;
        fn();
      }
    },
    end() {
      done = true;
      if (notify) {
        const fn = notify;
        notify = null;
        fn();
      }
    },
    async result(): Promise<any> {
      return undefined;
    },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<any>> {
          while (true) {
            if (i < queue.length) return { value: queue[i++], done: false };
            if (done) return { value: undefined, done: true };
            await new Promise<void>((r) => {
              notify = r;
            });
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal AssistantMessage factory — matches official pi-ai shape
// ---------------------------------------------------------------------------
function makeAssistantMessage(overrides: Record<string, any> = {}): any {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

// Official event shape helpers
const startEvent = (model = "claude-sonnet-4-6") => ({
  type: "start",
  partial: makeAssistantMessage({ model }),
});

const textDeltaEvent = (delta = "hello", contentIndex = 0) => ({
  type: "text_delta",
  contentIndex,
  delta,
  partial: makeAssistantMessage(),
});

const doneEvent = () => ({
  type: "done",
  reason: "stop",
  message: makeAssistantMessage({ stopReason: "stop" }),
});

const errorEvent = (errorMessage: string) => ({
  type: "error",
  reason: "error",
  error: makeAssistantMessage({ stopReason: "error", errorMessage }),
});

// ---------------------------------------------------------------------------
// Shared mock config — factory closures read this at call time
// ---------------------------------------------------------------------------
interface PiAiConfig {
  anthropicEvents: any[];
  anthropicThrows: unknown;
  anthropicThrowAfter: boolean; // true → throw after events are yielded
  bedrockEvents: any[];
  bedrockThrows: unknown;
  anthropicCallArgs: any[][];
  bedrockCallArgs: any[][];
}

const piAiConfig: PiAiConfig = {
  anthropicEvents: [],
  anthropicThrows: null,
  anthropicThrowAfter: false,
  bedrockEvents: [],
  bedrockThrows: null,
  anthropicCallArgs: [],
  bedrockCallArgs: [],
};

// ---------------------------------------------------------------------------
// Mocks (vi.mock is hoisted; factories run lazily at first import)
// ---------------------------------------------------------------------------
vi.mock("@mariozechner/pi-coding-agent", async () => {
  const stub = await import("../../test/stubs/pi-coding-agent.js");
  return {
    ...stub,
    // Override getAgentDir to point at our isolated tempHome
    getAgentDir: () => join(tempHome, ".pi", "agent"),
  };
});

vi.mock("@mariozechner/pi-tui", () => import("../../test/stubs/pi-tui.js"));

vi.mock("@mariozechner/pi-ai", () => ({
  createAssistantMessageEventStream: makePushableStream,

  async *streamSimpleAnthropic(model: any, context: any, options: any) {
    piAiConfig.anthropicCallArgs.push([model, context, options]);
    if (piAiConfig.anthropicThrows && !piAiConfig.anthropicThrowAfter) {
      throw piAiConfig.anthropicThrows;
    }
    for (const e of piAiConfig.anthropicEvents) {
      yield e;
    }
    if (piAiConfig.anthropicThrows && piAiConfig.anthropicThrowAfter) {
      throw piAiConfig.anthropicThrows;
    }
  },

  async *streamSimple(model: any, context: any, options: any) {
    piAiConfig.bedrockCallArgs.push([model, context, options]);
    if (piAiConfig.bedrockThrows) throw piAiConfig.bedrockThrows;
    for (const e of piAiConfig.bedrockEvents) {
      yield e;
    }
  },
}));

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------
let tempHome = "";
const originalEnv = {
  HOME: process.env.HOME,
  AWS_PROFILE: process.env.AWS_PROFILE,
  AWS_REGION: process.env.AWS_REGION,
  AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
};

beforeAll(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "clauderock-test-"));
  mkdirSync(join(tempHome, ".pi", "agent"), { recursive: true });
  mkdirSync(join(tempHome, ".aws"), { recursive: true });
  process.env.HOME = tempHome;
});

afterAll(async () => {
  if (tempHome) await rm(tempHome, { force: true, recursive: true });
  process.env.HOME = originalEnv.HOME;
  process.env.AWS_PROFILE = originalEnv.AWS_PROFILE;
  process.env.AWS_REGION = originalEnv.AWS_REGION;
  process.env.AWS_DEFAULT_REGION = originalEnv.AWS_DEFAULT_REGION;
  process.env.AWS_ACCESS_KEY_ID = originalEnv.AWS_ACCESS_KEY_ID;
  process.env.AWS_SECRET_ACCESS_KEY = originalEnv.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_SESSION_TOKEN = originalEnv.AWS_SESSION_TOKEN;
});

beforeEach(() => {
  process.env.HOME = tempHome;
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;

  // Reset mock config
  piAiConfig.anthropicEvents = [];
  piAiConfig.anthropicThrows = null;
  piAiConfig.anthropicThrowAfter = false;
  piAiConfig.bedrockEvents = [];
  piAiConfig.bedrockThrows = null;
  piAiConfig.anthropicCallArgs = [];
  piAiConfig.bedrockCallArgs = [];

  // Clear any persisted cache
  try {
    unlinkSync(join(tempHome, ".pi", "agent", "clauderock-state.json"));
  } catch {
    // ignore: file may not exist
  }

  try {
    unlinkSync(join(tempHome, ".aws", "credentials"));
  } catch {
    // ignore: file may not exist
  }

  // Fresh module state (resets fallbackActive, pendingNotification, etc.)
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function collectStream(stream: any): Promise<any[]> {
  const events: any[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

interface SetupOptions {
  preSeedCache?: { exhausted: boolean; reason?: string };
}

async function setup(opts: SetupOptions = {}) {
  if (opts.preSeedCache) {
    writeFileSync(
      join(tempHome, ".pi", "agent", "clauderock-state.json"),
      JSON.stringify({
        exhausted: opts.preSeedCache.exhausted,
        since: new Date().toISOString(),
        reason: opts.preSeedCache.reason ?? "",
      }),
    );
  }

  // Dynamic import gives a fresh module (vi.resetModules() was called in beforeEach)
  const mod = await import("./index.ts");
  const mockPi = createMockPi();
  const ctx = createMockContext();
  mod.default(mockPi.pi as never);

  const provider = mockPi.providers.get("anthropic") as any;
  const streamFn: (model: any, context?: any, options?: any) => any = provider.streamSimple;

  return { mod, mockPi, ctx, streamFn };
}

function writeAwsCredentialsFile(content: string): void {
  writeFileSync(join(tempHome, ".aws", "credentials"), content);
}

// Known model with a Bedrock mapping
const SONNET_MODEL = { id: "claude-sonnet-4-6", provider: "anthropic" };
// Haiku model (also has a Bedrock mapping)
const HAIKU_MODEL = { id: "claude-haiku-4-5", provider: "anthropic" };
// Model without any Bedrock mapping
const UNMAPPED_MODEL = { id: "claude-unknown-99", provider: "anthropic" };
const CTX = {};

// ---------------------------------------------------------------------------
// Model ID mapping
// ---------------------------------------------------------------------------
describe("model ID mapping", () => {
  it("routes known Anthropic model to correct Bedrock ID when fallback triggers", async () => {
    piAiConfig.anthropicEvents = [errorEvent("billing limit exceeded")];
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
    expect(piAiConfig.bedrockCallArgs[0][0].id).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("routes claude-haiku-4-5 to its Bedrock ID", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(HAIKU_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs[0][0].id).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });

  it("routes claude-haiku-4-5-20251001 to same Bedrock ID as claude-haiku-4-5", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn({ id: "claude-haiku-4-5-20251001", provider: "anthropic" }, CTX));

    expect(piAiConfig.bedrockCallArgs[0][0].id).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });

  it("clears Anthropic baseUrl when constructing the Bedrock model", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn({
      id: "claude-opus-4-6",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
    }, CTX));

    expect(piAiConfig.bedrockCallArgs[0][0].id).toBe("us.anthropic.claude-opus-4-6-v1");
    expect(piAiConfig.bedrockCallArgs[0][0].baseUrl).toBe("");
  });

  it("does not call Bedrock for unmapped model on quota error — forwards error", async () => {
    piAiConfig.anthropicEvents = [errorEvent("billing limit exceeded")];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(UNMAPPED_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("normalizes a leaked Bedrock ID back to the Anthropic ID before processing", async () => {
    // Simulate a Bedrock ID that leaked into model state
    const leakedModel = { id: "us.anthropic.claude-sonnet-4-6", provider: "anthropic" };
    piAiConfig.anthropicEvents = [startEvent("us.anthropic.claude-sonnet-4-6"), doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(leakedModel, CTX));

    // Anthropic was called with the normalized ID, not the Bedrock ID
    expect(piAiConfig.anthropicCallArgs[0][0].id).toBe("claude-sonnet-4-6");
  });

  it("normalizes Bedrock ID without region prefix", async () => {
    const leakedModel = { id: "anthropic.claude-opus-4-6-v1", provider: "anthropic" };
    piAiConfig.anthropicEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(leakedModel, CTX));

    expect(piAiConfig.anthropicCallArgs[0][0].id).toBe("claude-opus-4-6");
  });
});

// ---------------------------------------------------------------------------
// Error detection via event stream (error.errorMessage keywords)
// ---------------------------------------------------------------------------
describe("quota error detection via event stream", () => {
  for (const keyword of ["billing", "credit", "quota", "spend limit"]) {
    it(`triggers fallback when error.errorMessage contains "${keyword}"`, async () => {
      piAiConfig.anthropicEvents = [errorEvent(`Your ${keyword} has been exhausted`)];
      piAiConfig.bedrockEvents = [doneEvent()];

      const { streamFn } = await setup();
      await collectStream(streamFn(SONNET_MODEL, CTX));

      expect(piAiConfig.bedrockCallArgs.length).toBe(1);
    });
  }

  it("is case-insensitive for keyword matching", async () => {
    piAiConfig.anthropicEvents = [errorEvent("BILLING LIMIT EXCEEDED")];
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });
});

describe("rate-limit error detection via event stream", () => {
  for (const keyword of ["rate limit", "rate-limit", "rate_limit_error", "too many requests"]) {
    it(`triggers fallback when error.errorMessage contains "${keyword}"`, async () => {
      piAiConfig.anthropicEvents = [errorEvent(`Request failed: ${keyword}`)];
      piAiConfig.bedrockEvents = [doneEvent()];

      const { streamFn } = await setup();
      await collectStream(streamFn(SONNET_MODEL, CTX));

      expect(piAiConfig.bedrockCallArgs.length).toBe(1);
    });
  }
});

describe("non-triggering error via event stream", () => {
  it("does not trigger fallback for unrelated error message", async () => {
    piAiConfig.anthropicEvents = [errorEvent("network connection refused")];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error detection via thrown errors
// ---------------------------------------------------------------------------
describe("quota/rate-limit detection via thrown error", () => {
  it("triggers fallback when thrown error has status 402", async () => {
    const err = Object.assign(new Error("payment required"), { status: 402 });
    piAiConfig.anthropicThrows = err;
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });

  it("triggers fallback when thrown error has status 429", async () => {
    const err = Object.assign(new Error("too many requests"), { status: 429 });
    piAiConfig.anthropicThrows = err;
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });

  it("triggers fallback when thrown error has statusCode 429", async () => {
    const err = Object.assign(new Error("request failed"), { statusCode: 429 });
    piAiConfig.anthropicThrows = err;
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });

  it("triggers fallback when thrown Error message contains billing keyword", async () => {
    piAiConfig.anthropicThrows = new Error("billing limit exceeded");
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });

  it("triggers fallback when thrown error has nested error.message with rate-limit keyword", async () => {
    const err = { error: { message: "rate limit reached" } };
    piAiConfig.anthropicThrows = err;
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });

  it("triggers fallback when thrown error has nested error.errorMessage with quota keyword", async () => {
    const err = { error: { errorMessage: "quota exhausted" } };
    piAiConfig.anthropicThrows = err;
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });

  it("does NOT trigger fallback for unrelated thrown error — emits error event", async () => {
    piAiConfig.anthropicThrows = new Error("dns lookup failed");

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("does NOT trigger fallback for non-object thrown value", async () => {
    piAiConfig.anthropicThrows = "quota exceeded"; // string, not object

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
    // The error is wrapped and forwarded
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path — Anthropic succeeds
// ---------------------------------------------------------------------------
describe("happy path: Anthropic succeeds", () => {
  it("forwards all events when Anthropic returns start + text_delta + done", async () => {
    piAiConfig.anthropicEvents = [startEvent(), textDeltaEvent("Hello"), doneEvent()];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
  });

  it("buffers start event until first non-start event, then flushes both", async () => {
    piAiConfig.anthropicEvents = [startEvent(), textDeltaEvent("hi"), doneEvent()];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(events[0].type).toBe("start");
    expect(events[1].type).toBe("text_delta");
  });

  it("flushes buffered start even when stream ends with only start event", async () => {
    piAiConfig.anthropicEvents = [startEvent()];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("start");
  });

  it("does not call Bedrock on clean success", async () => {
    piAiConfig.anthropicEvents = [startEvent(), doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fallback triggered via event stream
// ---------------------------------------------------------------------------
describe("fallback triggered via event stream", () => {
  it("on quota error event → switches to Bedrock and forwards Bedrock events", async () => {
    piAiConfig.anthropicEvents = [startEvent(), errorEvent("billing limit exceeded")];
    piAiConfig.bedrockEvents = [startEvent(), textDeltaEvent("from bedrock"), doneEvent()];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    // Events should be from Bedrock, not Anthropic
    expect(events.some((e) => e.type === "text_delta" && e.delta === "from bedrock")).toBe(true);
    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });

  it("writes cache file when fallback triggers", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    const cacheFile = join(tempHome, ".pi", "agent", "clauderock-state.json");
    const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(cache.exhausted).toBe(true);
    expect(typeof cache.since).toBe("string");
  });

  it("queues quota_exhausted notification after fallback triggers", async () => {
    piAiConfig.anthropicEvents = [errorEvent("billing limit")];
    piAiConfig.bedrockEvents = [doneEvent()];

    const { mockPi, ctx, streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    const notifyMsgs: string[] = [];
    (ctx.ui.notify as any) = (msg: string) => notifyMsgs.push(msg);

    await mockPi.fireLifecycle("turn_end", {}, ctx);

    expect(notifyMsgs.some((m) => m.includes("rate limit") || m.includes("Clauderock"))).toBe(true);
  });

  it("does not call Anthropic again on Bedrock path — only Bedrock is called", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.anthropicCallArgs.length).toBe(1); // one attempt only
    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fallback triggered via thrown error
// ---------------------------------------------------------------------------
describe("fallback triggered via thrown error", () => {
  it("on thrown quota error → switches to Bedrock", async () => {
    piAiConfig.anthropicThrows = new Error("billing limit exceeded");
    piAiConfig.bedrockEvents = [startEvent(), doneEvent()];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
    expect(events.some((e) => e.type === "start")).toBe(true);
  });

  it("flushes buffered start before error when non-quota error is thrown after start", async () => {
    piAiConfig.anthropicEvents = [startEvent()];
    piAiConfig.anthropicThrows = new Error("unexpected failure");
    piAiConfig.anthropicThrowAfter = true;

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(UNMAPPED_MODEL, CTX));

    // start should come first, then error
    expect(events[0].type).toBe("start");
    expect(events[1].type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// No Bedrock mapping on error
// ---------------------------------------------------------------------------
describe("no Bedrock mapping on quota/rate-limit error", () => {
  it("event-stream path: error forwarded when no mapping exists", async () => {
    piAiConfig.anthropicEvents = [startEvent(), errorEvent("billing limit exceeded")];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(UNMAPPED_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("thrown-error path: error forwarded when no mapping exists", async () => {
    piAiConfig.anthropicThrows = new Error("quota exceeded");

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(UNMAPPED_MODEL, CTX));

    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("pending start is flushed before error event when no Bedrock mapping", async () => {
    piAiConfig.anthropicEvents = [startEvent(), errorEvent("billing limit")];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(UNMAPPED_MODEL, CTX));

    // start comes first even though an error triggered
    expect(events[0].type).toBe("start");
    expect(events[1].type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Error after content already started — no fallback
// ---------------------------------------------------------------------------
describe("error after content started", () => {
  it("does not fall back when quota error arrives after text_delta", async () => {
    piAiConfig.anthropicEvents = [
      startEvent(),
      textDeltaEvent("partial text"),
      errorEvent("billing limit exceeded"),
    ];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    // Bedrock is NOT called because content was already received
    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fallback already active (from persisted cache)
// ---------------------------------------------------------------------------
describe("fallback already active from cache", () => {
  it("loads fallbackActive=true when cache file exists at startup", async () => {
    const { mockPi, ctx } = await setup({
      preSeedCache: { exhausted: true, reason: "quota exceeded" },
    });

    // Verify status bar reflects active state
    const statusCalls: string[] = [];
    (ctx.ui.setStatus as any) = (_key: string, val: string | undefined) => {
      if (val) statusCalls.push(val);
    };

    // session_start with anthropic provider should show active indicator
    await mockPi.fireLifecycle(
      "session_start",
      {},
      { ...ctx, model: { provider: "anthropic", id: "claude-sonnet-4-6" } },
    );

    // Fallback was active — Bedrock should be called directly (no Anthropic attempt)
    piAiConfig.bedrockEvents = [doneEvent()];
    const provider = mockPi.providers.get("anthropic") as any;
    await collectStream(provider.streamSimple(SONNET_MODEL, CTX));

    expect(piAiConfig.anthropicCallArgs.length).toBe(0);
    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });

  it("sends using_cached_fallback notification on message_start (user role) — right after user message", async () => {
    const { mockPi, ctx } = await setup({
      preSeedCache: { exhausted: true, reason: "quota exceeded" },
    });

    await mockPi.fireLifecycle(
      "session_start",
      { reason: "startup" },
      { ...ctx, model: { provider: "anthropic", id: "claude-sonnet-4-6" } },
    );

    const notifyMsgs: string[] = [];
    (ctx.ui.notify as any) = (msg: string) => notifyMsgs.push(msg);

    // agent_start must fire first (marks live turn, not history replay)
    await mockPi.fireLifecycle("agent_start", {}, ctx);
    await mockPi.fireLifecycle("message_start", { message: { role: "user", content: [] } }, ctx);

    expect(
      notifyMsgs.some((m) => m.includes("Clauderock") || m.includes("rate-limited") || m.includes("clauderock")),
    ).toBe(true);
  });

  it("does NOT notify on message_start for non-user roles", async () => {
    const { mockPi, ctx } = await setup({
      preSeedCache: { exhausted: true, reason: "quota exceeded" },
    });

    await mockPi.fireLifecycle(
      "session_start",
      { reason: "startup" },
      { ...ctx, model: { provider: "anthropic", id: "claude-sonnet-4-6" } },
    );

    const notifyMsgs: string[] = [];
    (ctx.ui.notify as any) = (msg: string) => notifyMsgs.push(msg);

    await mockPi.fireLifecycle("agent_start", {}, ctx);
    await mockPi.fireLifecycle("message_start", { message: { role: "assistant", content: [] } }, ctx);

    expect(notifyMsgs.length).toBe(0);
  });

  it("does NOT notify on message_start before agent_start (history replay suppression)", async () => {
    const { mockPi, ctx } = await setup({
      preSeedCache: { exhausted: true, reason: "quota exceeded" },
    });

    await mockPi.fireLifecycle(
      "session_start",
      { reason: "startup" },
      { ...ctx, model: { provider: "anthropic", id: "claude-sonnet-4-6" } },
    );

    const notifyMsgs: string[] = [];
    (ctx.ui.notify as any) = (msg: string) => notifyMsgs.push(msg);

    // No agent_start — simulates history replay on session load
    await mockPi.fireLifecycle("message_start", { message: { role: "user", content: [] } }, ctx);

    expect(notifyMsgs.length).toBe(0);
  });

  it("does NOT send cached_fallback notification again on second user message_start", async () => {
    const { mockPi, ctx } = await setup({
      preSeedCache: { exhausted: true, reason: "quota exceeded" },
    });

    await mockPi.fireLifecycle(
      "session_start",
      { reason: "startup" },
      { ...ctx, model: { provider: "anthropic", id: "claude-sonnet-4-6" } },
    );

    const notifyMsgs: string[] = [];
    (ctx.ui.notify as any) = (msg: string) => notifyMsgs.push(msg);

    await mockPi.fireLifecycle("agent_start", {}, ctx);
    await mockPi.fireLifecycle("message_start", { message: { role: "user", content: [] } }, ctx);
    await mockPi.fireLifecycle("message_start", { message: { role: "user", content: [] } }, ctx);

    expect(notifyMsgs.filter((m) => m.includes("Clauderock") || m.includes("rate-limited")).length).toBe(1);
  });

  it("calls Anthropic directly for unmapped model even when fallback is active", async () => {
    await setup({ preSeedCache: { exhausted: true } });
    piAiConfig.bedrockEvents = [];
    piAiConfig.anthropicEvents = [doneEvent()];

    const { streamFn } = await setup({ preSeedCache: { exhausted: true } });
    await collectStream(streamFn(UNMAPPED_MODEL, CTX));

    // No Bedrock mapping → Anthropic used
    expect(piAiConfig.anthropicCallArgs.length).toBeGreaterThan(0);
  });

  it("ignores cache file where exhausted=false", async () => {
    writeFileSync(
      join(tempHome, ".pi", "agent", "clauderock-state.json"),
      JSON.stringify({ exhausted: false, since: new Date().toISOString(), reason: "test" }),
    );

    piAiConfig.anthropicEvents = [doneEvent()];
    const { streamFn } = await setup(); // re-import with the false-exhausted cache

    await collectStream(streamFn(SONNET_MODEL, CTX));

    // Should have tried Anthropic (not jumped straight to Bedrock)
    expect(piAiConfig.anthropicCallArgs.length).toBe(1);
    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// streamViaBedrock — Bedrock model construction
// ---------------------------------------------------------------------------
describe("Bedrock model construction", () => {
  it("sets provider='bedrock' and api='bedrock-converse-stream' on the Bedrock model", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    const bedrockModel = piAiConfig.bedrockCallArgs[0][0];
    expect(bedrockModel.provider).toBe("bedrock");
    expect(bedrockModel.api).toBe("bedrock-converse-stream");
  });

  it("passes apiKey: undefined to the Bedrock stream call", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup();
    await collectStream(streamFn(SONNET_MODEL, CTX));

    const bedrockOptions = piAiConfig.bedrockCallArgs[0][2];
    expect(bedrockOptions?.apiKey).toBeUndefined();
  });
});

describe("Bedrock AWS credential sync", () => {
  it("loads AWS env credentials from the default profile file before Bedrock requests", async () => {
    writeAwsCredentialsFile([
      "[default]",
      "aws_access_key_id = old-key",
      "aws_secret_access_key = old-secret",
      "aws_session_token = old-token",
      "",
    ].join("\n"));

    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup({ preSeedCache: { exhausted: true, reason: "quota exceeded" } });
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(process.env.AWS_ACCESS_KEY_ID).toBe("old-key");
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("old-secret");
    expect(process.env.AWS_SESSION_TOKEN).toBe("old-token");
  });

  it("re-reads refreshed AWS profile file on the next Bedrock request", async () => {
    writeAwsCredentialsFile([
      "[default]",
      "aws_access_key_id = old-key",
      "aws_secret_access_key = old-secret",
      "aws_session_token = old-token",
      "",
    ].join("\n"));

    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup({ preSeedCache: { exhausted: true, reason: "quota exceeded" } });
    await collectStream(streamFn(SONNET_MODEL, CTX));

    writeAwsCredentialsFile([
      "[default]",
      "aws_access_key_id = new-key",
      "aws_secret_access_key = new-secret",
      "",
    ].join("\n"));

    piAiConfig.bedrockEvents = [doneEvent()];
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(process.env.AWS_ACCESS_KEY_ID).toBe("new-key");
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("new-secret");
    expect(process.env.AWS_SESSION_TOKEN).toBeUndefined();
  });
});

describe("Bedrock AWS credential source conflict avoidance", () => {
  it("clears AWS_PROFILE when static credentials are synced from profile file", async () => {
    writeAwsCredentialsFile([
      "[myprofile]",
      "aws_access_key_id = prof-key",
      "aws_secret_access_key = prof-secret",
      "",
    ].join("\n"));
    process.env.AWS_PROFILE = "myprofile";

    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup({ preSeedCache: { exhausted: true, reason: "quota exceeded" } });
    await collectStream(streamFn(SONNET_MODEL, CTX));

    // Static creds set, AWS_PROFILE cleared → no dual-source conflict
    expect(process.env.AWS_ACCESS_KEY_ID).toBe("prof-key");
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("prof-secret");
    expect(process.env.AWS_PROFILE).toBeUndefined();
  });

  it("sets AWS_PROFILE when no creds in file AND no env creds exist", async () => {
    // No env credentials, empty profile → AWS_PROFILE is last resort
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;

    piAiConfig.bedrockEvents = [doneEvent()];

    // Write a credentials file with only a profile name so getPreferredAwsProfile returns it,
    // but no actual keys so sync fails
    writeAwsCredentialsFile([
      "[myprofile]",
      "# no keys here",
      "",
    ].join("\n"));

    // Re-import to pick up the file with profile but no creds
    vi.resetModules();
    const mod2 = await import("./index.ts");
    const mockPi2 = createMockPi();
    // Pre-seed cache for fallback
    writeFileSync(
      join(tempHome, ".pi", "agent", "clauderock-state.json"),
      JSON.stringify({ exhausted: true, since: new Date().toISOString(), reason: "test" }),
    );
    mod2.default(mockPi2.pi as never);

    piAiConfig.bedrockEvents = [doneEvent()];
    const provider2 = mockPi2.providers.get("anthropic") as any;
    await collectStream(provider2.streamSimple(SONNET_MODEL, CTX));

    // No static creds, no env creds → AWS_PROFILE should be set as fallback
    expect(process.env.AWS_PROFILE).toBe("myprofile");
  });

  it("does NOT set AWS_PROFILE when profile is empty but env creds already exist", async () => {
    // Env has valid credentials; empty profile in file → don't override with AWS_PROFILE
    process.env.AWS_ACCESS_KEY_ID = "ASIAV3EXISTING";
    process.env.AWS_SECRET_ACCESS_KEY = "existing-secret";
    process.env.AWS_SESSION_TOKEN = "existing-token";

    writeAwsCredentialsFile([
      "[myprofile]",
      "# empty profile, no keys",
      "",
    ].join("\n"));

    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup({ preSeedCache: { exhausted: true, reason: "quota exceeded" } });
    await collectStream(streamFn(SONNET_MODEL, CTX));

    // Env creds preserved, AWS_PROFILE NOT set
    expect(process.env.AWS_ACCESS_KEY_ID).toBe("ASIAV3EXISTING");
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("existing-secret");
    expect(process.env.AWS_PROFILE).toBeUndefined();
  });

  it("never has both AWS_PROFILE and AWS_ACCESS_KEY_ID set after Bedrock request", async () => {
    writeAwsCredentialsFile([
      "[default]",
      "aws_access_key_id = test-key",
      "aws_secret_access_key = test-secret",
      "",
    ].join("\n"));
    process.env.AWS_PROFILE = "default";

    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup({ preSeedCache: { exhausted: true, reason: "quota exceeded" } });
    await collectStream(streamFn(SONNET_MODEL, CTX));

    // Either static creds OR AWS_PROFILE, never both
    const hasStaticCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    const hasProfile = !!process.env.AWS_PROFILE;
    expect(hasStaticCreds && hasProfile).toBe(false);
  });

  it("clears AWS_PROFILE when env already has both AWS_PROFILE AND static creds (sync fails)", async () => {
    // Simulates SSO tools that set both AWS_PROFILE and static creds
    process.env.AWS_PROFILE = "sso-profile";
    process.env.AWS_ACCESS_KEY_ID = "ASIAV3SSOKEY";
    process.env.AWS_SECRET_ACCESS_KEY = "sso-secret";
    process.env.AWS_SESSION_TOKEN = "sso-token";

    // No matching profile in credentials file → sync will fail
    writeAwsCredentialsFile([
      "[other-profile]",
      "aws_access_key_id = other-key",
      "aws_secret_access_key = other-secret",
      "",
    ].join("\n"));

    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup({ preSeedCache: { exhausted: true, reason: "quota exceeded" } });
    await collectStream(streamFn(SONNET_MODEL, CTX));

    // Static creds preserved, AWS_PROFILE cleared to prevent dual-source conflict
    expect(process.env.AWS_ACCESS_KEY_ID).toBe("ASIAV3SSOKEY");
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("sso-secret");
    expect(process.env.AWS_PROFILE).toBeUndefined();
  });

  it("does not pass profile to streamSimple when static creds exist in env", async () => {
    process.env.AWS_ACCESS_KEY_ID = "ASIAV3EXISTING";
    process.env.AWS_SECRET_ACCESS_KEY = "existing-secret";

    writeAwsCredentialsFile([
      "[myprofile]",
      "# empty profile, no keys",
      "",
    ].join("\n"));

    piAiConfig.bedrockEvents = [doneEvent()];

    const { streamFn } = await setup({ preSeedCache: { exhausted: true, reason: "quota exceeded" } });
    await collectStream(streamFn(SONNET_MODEL, CTX));

    // streamSimple (Bedrock) should receive profile: undefined, not a profile name
    const bedrockOptions = piAiConfig.bedrockCallArgs[0][2];
    expect(bedrockOptions?.profile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// streamViaBedrock — start event model ID patching
// ---------------------------------------------------------------------------
describe("streamViaBedrock: start event model ID patching", () => {
  it("rewrites top-level model field in start event to originalModel.id", async () => {
    // Non-standard start event with top-level model field (not official 'partial' format)
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [
      { type: "start", model: "us.anthropic.claude-sonnet-4-6" },
      doneEvent(),
    ];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    const startEv = events.find((e) => e.type === "start");
    expect(startEv?.model).toBe("claude-sonnet-4-6");
  });

  it("rewrites message.model in start event to originalModel.id", async () => {
    piAiConfig.anthropicEvents = [errorEvent("billing limit")];
    piAiConfig.bedrockEvents = [
      { type: "start", message: { model: "us.anthropic.claude-sonnet-4-6", other: "data" } },
      doneEvent(),
    ];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    const startEv = events.find((e) => e.type === "start");
    expect(startEv?.message?.model).toBe("claude-sonnet-4-6");
    expect(startEv?.message?.other).toBe("data"); // other fields preserved
  });

  it("rewrites partial.model in the official start event format", async () => {
    // Official format: { type: "start", partial: AssistantMessage }
    const bedrockStart = startEvent("us.anthropic.claude-sonnet-4-6");
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [bedrockStart, doneEvent()];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    const startEv = events.find((e) => e.type === "start");
    expect(startEv?.partial?.model).toBe("claude-sonnet-4-6");
  });

  it("rewrites done message.model to prevent Bedrock ID leaking into session history", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [
      {
        type: "done",
        reason: "stop",
        message: makeAssistantMessage({
          api: "bedrock-converse-stream",
          provider: "bedrock",
          model: "us.anthropic.claude-sonnet-4-6",
        }),
      },
    ];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    const doneEv = events.find((e) => e.type === "done");
    expect(doneEv?.message?.model).toBe("claude-sonnet-4-6");
  });

  it("forwards non-start events from Bedrock unchanged", async () => {
    const delta = textDeltaEvent("bedrock output");
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockEvents = [delta, doneEvent()];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(events).toContainEqual(delta);
  });
});

// ---------------------------------------------------------------------------
// streamViaBedrock — Bedrock error wrapping
// ---------------------------------------------------------------------------
describe("streamViaBedrock: Bedrock error wrapping", () => {
  it("wraps Bedrock failure in a descriptive error with 'Clauderock fallback failed' prefix", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    piAiConfig.bedrockThrows = new Error("credentials not found");

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    const errEv = events.find((e) => e.type === "error");
    expect(errEv).toBeDefined();
    const errMsg = errEv?.error?.message ?? errEv?.error?.errorMessage ?? String(errEv?.error);
    expect(errMsg).toMatch(/Clauderock fallback failed/i);
    expect(errMsg).toContain("credentials not found");
  });

  it("includes 'Claude API quota/rate-limit was exhausted' in Bedrock failure message", async () => {
    piAiConfig.anthropicEvents = [errorEvent("billing limit")];
    piAiConfig.bedrockThrows = new Error("auth error");

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    const errEv = events.find((e) => e.type === "error");
    const errMsg = errEv?.error?.message ?? errEv?.error?.errorMessage ?? String(errEv?.error);
    expect(errMsg).toContain("quota/rate-limit was exhausted");
  });

  it("includes AWS SDK metadata (name, httpStatusCode, fault) in error message for opaque errors", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    // Simulate a real AWS SDK UnknownError with $metadata
    const awsErr = Object.assign(new Error("Unknown: UnknownError"), {
      name: "UnknownError",
      $metadata: { httpStatusCode: 403, requestId: "abc-123", attempts: 1 },
      $fault: "client",
      Code: "AccessDeniedException",
    });
    piAiConfig.bedrockThrows = awsErr;

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    const errEv = events.find((e) => e.type === "error");
    const errMsg = errEv?.error?.message ?? String(errEv?.error);
    // Should include the enriched details, not just 'Unknown: UnknownError'
    // Note: requestId is intentionally excluded from UI-safe messages (logged to console instead)
    expect(errMsg).toContain("UnknownError");
    expect(errMsg).toContain("HTTP 403");
    expect(errMsg).toContain("AccessDeniedException");
    expect(errMsg).toContain("fault=client");
  });

  it("enriches error events from Bedrock stream (not just thrown errors)", async () => {
    piAiConfig.anthropicEvents = [errorEvent("quota exceeded")];
    // Bedrock stream emits an error event with an opaque message
    piAiConfig.bedrockEvents = [
      { type: "error", error: { message: "Unknown: UnknownError", name: "UnknownError", $metadata: { httpStatusCode: 500 } } },
    ];

    const { streamFn } = await setup();
    const events = await collectStream(streamFn(SONNET_MODEL, CTX));

    const errEv = events.find((e) => e.type === "error");
    const errMsg = errEv?.error?.message ?? String(errEv?.error);
    expect(errMsg).toContain("HTTP 500");
  });
});

// ---------------------------------------------------------------------------
// /clauderock off command — resets fallback state
// ---------------------------------------------------------------------------
describe("/clauderock off command", () => {
  it("clears fallback state and cache, then routes through Anthropic", async () => {
    // Start with active fallback
    const { mockPi, ctx, streamFn } = await setup({
      preSeedCache: { exhausted: true, reason: "test" },
    });

    // Trigger 'off'
    const commandDef = mockPi.commands.get("clauderock") as any;
    await commandDef.handler("off", ctx);

    // After /clauderock off, Anthropic should be called (not Bedrock directly)
    piAiConfig.anthropicEvents = [doneEvent()];
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.anthropicCallArgs.length).toBe(1);
    expect(piAiConfig.bedrockCallArgs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// /clauderock on command — forces fallback state
// ---------------------------------------------------------------------------
describe("/clauderock on command", () => {
  it("forces Bedrock routing even without a prior quota error", async () => {
    const { mockPi, ctx, streamFn } = await setup();
    const commandDef = mockPi.commands.get("clauderock") as any;
    await commandDef.handler("on", ctx);

    piAiConfig.bedrockEvents = [doneEvent()];
    await collectStream(streamFn(SONNET_MODEL, CTX));

    expect(piAiConfig.anthropicCallArgs.length).toBe(0);
    expect(piAiConfig.bedrockCallArgs.length).toBe(1);
  });

  it("writes cache file with manually-forced reason", async () => {
    const { mockPi, ctx } = await setup();
    const commandDef = mockPi.commands.get("clauderock") as any;
    await commandDef.handler("on", ctx);

    const cacheFile = join(tempHome, ".pi", "agent", "clauderock-state.json");
    const cache = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(cache.exhausted).toBe(true);
    expect(cache.reason).toContain("manually forced");
  });
});

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------
describe("provider registration", () => {
  it("registers an 'anthropic' provider with api='anthropic-messages'", async () => {
    const { mockPi } = await setup();
    const provider = mockPi.providers.get("anthropic") as any;
    expect(provider).toBeDefined();
    expect(provider.api).toBe("anthropic-messages");
    expect(typeof provider.streamSimple).toBe("function");
  });
});
