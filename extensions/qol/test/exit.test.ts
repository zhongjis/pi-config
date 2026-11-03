import { describe, expect, it, vi } from "vitest";
import exitExtension from "../src/exit.js";

type Command = {
  description: string;
  handler(args: string, ctx: { shutdown(): void }): Promise<void>;
};

function activate(mode: string) {
  let registeredName: string | undefined;
  let registeredCommand: Command | undefined;
  let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
  exitExtension({
    on(event: string, handler: (event: unknown, ctx: unknown) => void): void {
      if (event === "session_start") sessionStart = handler;
    },
    registerCommand(name: string, command: Command): void {
      registeredName = name;
      registeredCommand = command;
    },
  } as never);
  sessionStart?.({}, { mode });
  return { registeredName, registeredCommand };
}

describe("exit command characterization", () => {
  it("registers exit and shuts down exactly once", async () => {
    const { registeredName, registeredCommand } = activate("tui");
    const shutdown = vi.fn();

    expect(registeredName).toBe("exit");
    await registeredCommand?.handler("ignored arguments", { shutdown });

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("does not register exit outside the terminal", () => {
    expect(activate("rpc").registeredName).toBeUndefined();
  });
});
