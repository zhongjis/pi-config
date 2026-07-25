import { describe, expect, it, vi } from "vitest";
import exitExtension from "../src/exit.js";

type Command = {
  description: string;
  handler(args: string, ctx: { shutdown(): void }): Promise<void>;
};

describe("exit command characterization", () => {
  it("registers exit with its current description and shuts down exactly once", async () => {
    let registeredName: string | undefined;
    let registeredCommand: Command | undefined;
    exitExtension({
      registerCommand(name: string, command: Command): void {
        registeredName = name;
        registeredCommand = command;
      },
    } as never);
    const shutdown = vi.fn();

    expect(registeredName).toBe("exit");
    expect(registeredCommand?.description).toBe("Exit pi cleanly");
    await registeredCommand?.handler("ignored arguments", { shutdown });

    expect(shutdown).toHaveBeenCalledOnce();
  });
});
