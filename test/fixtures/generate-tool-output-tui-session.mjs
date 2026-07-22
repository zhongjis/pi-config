#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

const [outputArg, ...extraArgs] = process.argv.slice(2);
if (!outputArg || extraArgs.length > 0) {
  throw new Error("Usage: generate-tool-output-tui-session.mjs /tmp/session.jsonl");
}

const outputPath = resolve(outputArg);
const tempRoot = resolve(tmpdir());
if (outputPath === tempRoot || !outputPath.startsWith(`${tempRoot}${sep}`) || !outputPath.endsWith(".jsonl")) {
  throw new Error("Output must be a caller-supplied .jsonl path under /tmp");
}

const timestamp = "2026-04-24T00:00:00.000Z";
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const entries = [
  {
    type: "session",
    version: 3,
    id: "31d7f90e-7cf4-4d57-b116-31aa5fbb8860",
    timestamp,
    cwd: process.cwd(),
  },
  {
    type: "message",
    id: "a0000001",
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "tool-agent-renderer",
        name: "Agent",
        arguments: {
          prompt: "Audit all tool output renderers offline.",
          description: "renderer proof",
          subagent_type: "juling",
          skills: ["pi-extensions", "vitest"],
        },
      }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o",
      usage,
      stopReason: "toolUse",
      timestamp: Date.parse(timestamp),
    },
  },
  {
    type: "message",
    id: "a0000002",
    parentId: "a0000001",
    timestamp,
    message: {
      role: "toolResult",
      toolCallId: "tool-agent-renderer",
      toolName: "Agent",
      content: [{
        type: "text",
        text: "All 31 renderer pairs verified.\nFull renderer result retained for terminal expansion.",
      }],
      details: {
        displayName: "Juling",
        description: "renderer proof",
        subagentType: "juling",
        status: "completed",
      },
      isError: false,
      timestamp: Date.parse(timestamp),
    },
  },
  {
    type: "message",
    id: "a0000003",
    parentId: "a0000002",
    timestamp,
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "tool-steer-renderer",
        name: "steer_subagent",
        arguments: {
          agent_id: "missing-renderer-agent",
          message: "Capture complete renderer diagnostics.",
        },
      }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o",
      usage,
      stopReason: "toolUse",
      timestamp: Date.parse(timestamp),
    },
  },
  {
    type: "message",
    id: "a0000004",
    parentId: "a0000003",
    timestamp,
    message: {
      role: "toolResult",
      toolCallId: "tool-steer-renderer",
      toolName: "steer_subagent",
      content: [{
        type: "text",
        text: "Agent missing-renderer-agent not found. Full steering failure retained for diagnostics.",
      }],
      details: {},
      isError: true,
      timestamp: Date.parse(timestamp),
    },
  },
];

await writeFile(outputPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
