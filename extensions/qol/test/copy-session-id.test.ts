import { afterEach, describe, expect, it, vi } from "vitest";

const writeClipboardMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/clipboard.js", () => ({
  writeClipboard: writeClipboardMock,
}));

import copySessionIdExtension from "../src/copy-session-id.js";

type CommandContext = {
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
  readonly ui: {
    notify(message: string, type: "success" | "error"): void;
  };
};

type CommandHandler = (args: string, ctx: CommandContext) => Promise<void>;
type RegisteredCommand = {
  description: string;
  handler: CommandHandler;
};

const SESSION_ID = "019f7cb7-d269-7868-a64d-bbb2e14fc944";
const SESSION_FILE = "/tmp/session.jsonl";
const PAYLOAD = [
  "use pi-jsonl-logs skill to analyze the following session log based on user request",
  `session-id: ${JSON.stringify(SESSION_ID)}`,
  `session-log-path: ${JSON.stringify(SESSION_FILE)}`,
].join("\n");
const UNSAVED_PAYLOAD = [
  "use pi-jsonl-logs skill to analyze the following session log based on user request",
  `session-id: ${JSON.stringify(SESSION_ID)}`,
  "session-log-path: null",
].join("\n");
const STALE_ERROR = "This extension ctx is stale after session replacement or reload.";

function registerCommand(): RegisteredCommand {
  let registered: RegisteredCommand | undefined;

  copySessionIdExtension({
    registerCommand(name: string, command: RegisteredCommand) {
      if (name === "session:copy-id") registered = command;
    },
  } as never);

  expect(registered).toBeDefined();
  return registered!;
}

function createContext(sessionFile?: string) {
  let stale = false;
  const notify = vi.fn();
  const ui = { notify };
  const ctx = {
    sessionManager: {
      getSessionId: () => SESSION_ID,
      getSessionFile: () => sessionFile,
    },
    get ui() {
      if (stale) throw new Error(STALE_ERROR);
      return ui;
    },
  } satisfies CommandContext;

  return {
    ctx,
    notify,
    makeStale() {
      stale = true;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  writeClipboardMock.mockReset();
});

describe("session:copy-id", () => {
  it("registers the current command description", () => {
    expect(registerCommand().description).toBe(
      "Copy current session ID and session log path to clipboard",
    );
  });

  it("serializes an undefined session file as exact null metadata", async () => {
    writeClipboardMock.mockResolvedValue("wl-copy");
    const { ctx } = createContext(undefined);

    await registerCommand().handler("", ctx);

    expect(writeClipboardMock).toHaveBeenCalledWith(UNSAVED_PAYLOAD);
  });

  it("copies current session metadata and reports the successful backend", async () => {
    writeClipboardMock.mockResolvedValue("wl-copy");
    const { ctx, notify } = createContext(SESSION_FILE);

    await registerCommand().handler("", ctx);

    expect(writeClipboardMock).toHaveBeenCalledWith(PAYLOAD);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "Copied session metadata to clipboard via wl-copy",
      "success",
    );
  });

  it("does not turn a successful copy into a command error when the ctx becomes stale", async () => {
    const clipboard = deferred<string>();
    writeClipboardMock.mockReturnValue(clipboard.promise);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ctx, makeStale } = createContext(SESSION_FILE);

    const command = registerCommand().handler("", ctx);
    expect(writeClipboardMock).toHaveBeenCalledWith(PAYLOAD);
    makeStale();
    clipboard.resolve("wl-copy");

    await expect(command).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("prints the payload and reports the original clipboard failure", async () => {
    writeClipboardMock.mockRejectedValue(new Error("no clipboard backend"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ctx, notify } = createContext(SESSION_FILE);

    await registerCommand().handler("", ctx);

    expect(log).toHaveBeenCalledWith(PAYLOAD);
    expect(notify).toHaveBeenCalledWith(
      `Clipboard copy failed: no clipboard backend\n${PAYLOAD}`,
      "error",
    );
  });

  it("preserves the clipboard failure when its error notification ctx is stale", async () => {
    const clipboard = deferred<string>();
    writeClipboardMock.mockReturnValue(clipboard.promise);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, makeStale } = createContext(SESSION_FILE);

    const command = registerCommand().handler("", ctx);
    makeStale();
    clipboard.reject(new Error("no clipboard backend"));

    await expect(command).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(PAYLOAD);
    expect(error).toHaveBeenCalledWith("Clipboard copy failed: no clipboard backend");
  });
});
