import { describe, expect, it, vi } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import superpowersExtension from "../index.js";

describe("superpowers extension", () => {
  it("registers the /superpowers help command", async () => {
    const mock = createMockPi();
    superpowersExtension(mock.pi as never);

    expect(mock.commands.has("superpowers")).toBe(true);

    const command = mock.commands.get("superpowers") as {
      handler: (args: string, ctx: { ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>;
    };
    const notify = vi.fn();

    await command.handler("", { ui: { notify } });

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("/mode superpowers"),
      "info",
    );
  });
});
