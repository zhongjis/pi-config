import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import initExtension from "../index.js";
import { INIT_DEEP_TEMPLATE } from "../src/init-deep-template.js";
import { INIT_DOX_TEMPLATE } from "../src/init-dox-template.js";

type InitCommand = {
  description: string;
  handler: (args: string, ctx: ReturnType<typeof createMockContext>) => Promise<void> | void;
};

type SentMessage = {
  content: string;
  display: boolean;
};

function setupExtension() {
  const mock = createMockPi();
  initExtension(mock.pi as never);
  return mock;
}

function getCommand(mock: ReturnType<typeof createMockPi>, name: string): InitCommand {
  const command = mock.commands.get(name);
  expect(command, `broken init command contract: ${name} must be registered`).toBeDefined();
  return command as InitCommand;
}

function expectTemplateMarkers(label: string, template: string, markers: string[]) {
  for (const marker of markers) {
    expect(template, `broken ${label} template contract: missing marker ${marker}`).toContain(marker);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("init extension commands", () => {
  it("registers exactly init-deep and init-dox with useful descriptions", () => {
    const mock = setupExtension();

    expect(
      Array.from(mock.commands.keys()),
      "broken init command contract: registered command set changed",
    ).toEqual(["init-deep", "init-dox"]);

    expect(
      getCommand(mock, "init-deep").description,
      "broken init-deep command contract: description should mention AGENTS.md hierarchy",
    ).toMatch(/AGENTS\.md.*hierarch|hierarch.*AGENTS\.md/i);
    expect(
      getCommand(mock, "init-dox").description,
      "broken init-dox command contract: description should mention DOX migration",
    ).toMatch(/DOX.*(initialize|migrate)|(?:initialize|migrate).*DOX/i);
  });

  it.each([
    {
      name: "init-deep",
      rawArgs: "  --create-new --max-depth=2  ",
      templateMarker: "# /init-deep",
    },
    {
      name: "init-dox",
      rawArgs: "  docs/extensions --broader-changes  ",
      templateMarker: "# /init-dox",
    },
  ])("$name forwards raw args and triggers a follow-up turn", async ({ name, rawArgs, templateMarker }) => {
    const mock = setupExtension();
    const sendMessage = vi.spyOn(mock.pi, "sendMessage");
    const ctx = createMockContext();

    await getCommand(mock, name).handler(rawArgs, ctx);

    expect(sendMessage, `broken ${name} command contract: sendMessage calls changed`).toHaveBeenCalledTimes(1);
    const [message, options] = sendMessage.mock.calls[0] as [SentMessage, unknown];

    expect(message.display, `broken ${name} command contract: command prompt must be hidden`).toBe(false);
    expect(
      message.content,
      `broken ${name} command contract: command template marker missing`,
    ).toContain(`<command-instruction>\n${templateMarker}`);
    expect(
      message.content,
      `broken ${name} command contract: raw args not forwarded exactly`,
    ).toContain(`<user-request>${rawArgs}</user-request>`);
    expect(options, `broken ${name} command contract: follow-up trigger changed`).toEqual({
      deliverAs: "followUp",
      triggerTurn: true,
    });
  });

  it.each(["init-deep", "init-dox"])("%s notifies only when UI is present", async (name) => {
    const mock = setupExtension();
    vi.spyOn(mock.pi, "sendMessage");

    const uiCtx = createMockContext();
    const notify = vi.spyOn(uiCtx.ui, "notify");
    await getCommand(mock, name).handler("", uiCtx);
    expect(notify, `broken ${name} command contract: UI notification missing`).toHaveBeenCalledTimes(1);

    const headlessCtx = { ...createMockContext(), hasUI: false };
    const headlessNotify = vi.spyOn(headlessCtx.ui, "notify");
    await getCommand(mock, name).handler("", headlessCtx);
    expect(headlessNotify, `broken ${name} command contract: headless notify must be gated`).not.toHaveBeenCalled();
  });
});

describe("init extension templates", () => {
  it("keeps init-deep upstream-inspired contract markers", () => {
    expectTemplateMarkers("init-deep", INIT_DEEP_TEMPLATE, [
      "CodeGraph",
      "LSP",
      "AGENTS.md and CLAUDE.md",
      "Dynamic Background Exploration by Project Scale",
      "chengfeng",
      "centrality",
      "Root first",
      "dedupe complete; trim complete",
    ]);
  });

  it("keeps init-dox DOX context/branch contract markers", () => {
    expectTemplateMarkers("init-dox", INIT_DOX_TEMPLATE, [
      "https://github.com/agent0ai/dox",
      "README",
      "Child DOX Index",
      "does NOT exist",
      "ALREADY exists",
      "ambiguous",
      "byte-for-byte",
      "curl -fsSL https://raw.githubusercontent.com/agent0ai/dox/main/AGENTS.md",
    ]);
  });
});
