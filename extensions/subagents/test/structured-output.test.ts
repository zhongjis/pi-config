import type { AgentSession, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { compileJsonSchema } from "../src/graph/json-schema.js";
import {
  createStructuredCapture,
  createStructuredOutputTool,
  repairStructuredOutput,
  resetStructuredCapture,
  structuredFailure,
} from "../src/structured-output.js";

function setup() {
  const result = compileJsonSchema({
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  });
  if (!result.ok) throw new Error(result.message);
  const capture = createStructuredCapture();
  const tool = createStructuredOutputTool(result.compiled, capture);
  const execute = (params: unknown) => tool.execute("result", params, undefined, undefined, {} as ExtensionToolContext);
  return { capture, execute };
}

function fakeSession(prompt = vi.fn(async (_text: string) => {})) {
  const waitForIdle = vi.fn(async () => {});
  return { prompt, waitForIdle, session: { prompt, waitForIdle } as unknown as AgentSession };
}

describe("StructuredOutput retry budget", () => {
  it("allows two schema failures followed by a valid call", async () => {
    const { capture, execute } = setup();
    for (let i = 0; i < 2; i++) {
      await expect(execute({ answer: i })).rejects.toThrow("did not match the required schema");
    }
    expect(capture.failedCalls).toBe(2);
    expect(capture.exhausted).toBe(false);
    expect(capture.json).toBeUndefined();
    const result = await execute({ answer: "validated" });
    expect(result.terminate).not.toBe(true);
    expect(capture.json).toBe(JSON.stringify({ answer: "validated" }));
    expect(capture.lastError).toBeUndefined();
    expect(structuredFailure(capture)).toBeUndefined();
    const { session, prompt } = fakeSession();
    expect(await repairStructuredOutput(session, capture)).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("returns a terminating result on the third failure and refuses further calls", async () => {
    const { capture, execute } = setup();
    await expect(execute({ answer: 1 })).rejects.toThrow();
    await expect(execute({ answer: 2 })).rejects.toThrow();
    const invalid = { answer: 3 };
    const result = await execute(invalid);
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringMatching(/recorded as invalid.*Stop/) }),
    ]));
    expect(capture.failedCalls).toBe(3);
    expect(capture.exhausted).toBe(true);
    expect(capture.json).toBeUndefined();
    expect(capture.lastInvalidOutput).toBe(JSON.stringify(invalid));
    expect((await execute({ answer: "too late" })).terminate).toBe(true);
    expect((await execute({ answer: 4 })).terminate).toBe(true);
    expect(capture.failedCalls).toBe(3);
    expect(capture.lastInvalidOutput).toBe(JSON.stringify(invalid));
    expect(capture.json).toBeUndefined();
    const { session, prompt, waitForIdle } = fakeSession();
    expect(await repairStructuredOutput(session, capture)).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(waitForIdle).not.toHaveBeenCalled();
  });

  it("counts failures during repair against the same budget", async () => {
    const { capture, execute } = setup();
    await expect(execute({ answer: 1 })).rejects.toThrow();
    await expect(execute({ answer: 2 })).rejects.toThrow();
    const { session, prompt, waitForIdle } = fakeSession(vi.fn(async (_text: string) => {
      expect((await execute({ answer: 3 })).terminate).toBe(true);
    }));
    expect(await repairStructuredOutput(session, capture)).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(capture.failedCalls).toBe(3);
    expect(capture.exhausted).toBe(true);
    expect(capture.json).toBeUndefined();
    expect(await repairStructuredOutput(session, capture)).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("still prompts once when the tool was never called", async () => {
    const { capture } = setup();
    const { session, prompt, waitForIdle } = fakeSession();
    expect(await repairStructuredOutput(session, capture)).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(capture.failedCalls).toBe(0);
    expect(structuredFailure(capture)).toContain("StructuredOutput was not produced");
  });

  it("reports exhaustion with the last error and bounded, unverified payload", async () => {
    const { capture, execute } = setup();
    await expect(execute({ answer: 1 })).rejects.toThrow();
    await expect(execute({ answer: 2 })).rejects.toThrow();
    const invalid = { answer: 3, extra: "x".repeat(3000) };
    await execute(invalid);
    expect(capture.lastInvalidOutput).toHaveLength(2000);
    expect(capture.lastInvalidOutput).toMatch(/\.\.\.\[truncated\]$/);
    if (capture.lastInvalidOutput === undefined) throw new Error("missing invalid payload");
    expect(JSON.stringify(invalid).startsWith(capture.lastInvalidOutput.split("...[truncated]")[0])).toBe(true);
    const failure = structuredFailure(capture);
    expect(failure).toContain("failed schema validation 3 times");
    expect(failure).toContain("unverified and was not used");
    expect(failure).toContain(`Last error: ${capture.lastError}`);
    expect(failure).toContain(`Last invalid output: ${capture.lastInvalidOutput}`);
    expect(capture.json).toBeUndefined();
  });

  it("resets every capture field and restores the full failure budget", async () => {
    const { capture, execute } = setup();
    await execute({ answer: "previous execution" });
    await expect(execute({ answer: 1 })).rejects.toThrow();
    await expect(execute({ answer: 2 })).rejects.toThrow();
    await execute({ answer: 3 });
    resetStructuredCapture(capture);
    expect(capture.json).toBeUndefined();
    expect(capture.called).toBe(false);
    expect(capture.lastError).toBeUndefined();
    expect(capture.failedCalls).toBe(0);
    expect(capture.exhausted).toBe(false);
    expect(capture.lastInvalidOutput).toBeUndefined();
    await expect(execute({ answer: 1 })).rejects.toThrow();
    await expect(execute({ answer: 2 })).rejects.toThrow();
    expect((await execute({ answer: 3 })).terminate).toBe(true);
    expect(capture.failedCalls).toBe(3);
    expect(capture.exhausted).toBe(true);
  });
});
