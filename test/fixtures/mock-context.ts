function createTheme() {
  return {
    bold(text: string) {
      return text;
    },
    dim(text: string) {
      return text;
    },
    fg(_color: string, text: string) {
      return text;
    },
    strikethrough(text: string) {
      return text;
    }
  };
}

function createUi() {
  const theme = createTheme();

  return {
    custom: async () => undefined,
    notify() {},
    onTerminalInput: () => () => {},
    requestRender() {},
    select: async () => undefined,
    setEditorComponent() {},
    setFooter() {},
    setHeader() {},
    setStatus() {},
    setWidget() {},
    theme
  };
}

function createSessionManager() {
  return {
    getBranch: () => [],
    getEntries: () => [],
    getLeafId: () => "leaf",
    getSessionFile: () => `${process.cwd()}/.pi/sessions/mock.jsonl`,
    getSessionId: () => "mock-session-id"
  };
}

export function createMockContext() {
  const ui = createUi();
  const sessionManager = createSessionManager();

  return {
    cwd: process.cwd(),
    getContextUsage: () => ({ contextWindow: 200_000, percent: 0, tokens: 0 }),
    getSystemPrompt: () => "",
    hasUI: true,
    model: { id: "mock-model", provider: "mock" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ apiKey: "mock-key", headers: {}, ok: true }),
      getAvailable: () => [{ id: "mock-model", provider: "mock" }]
    },
    newSession: async () => ({ cancelled: false }),
    sessionManager,
    ui,
    waitForIdle: async () => {}
  };
}
