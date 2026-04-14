type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

type EventHandler = (payload: unknown) => void;

export function createMockPi() {
  const lifecycleHandlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const shortcuts = new Map<string, unknown>();
  const providers = new Map<string, unknown>();
  const flags = new Map<string, unknown>();
  const renderers = new Map<string, unknown>();
  const widgets = new Map<string, unknown>();

  const events = {
    on(event: string, handler: EventHandler) {
      const next = busHandlers.get(event) ?? [];
      next.push(handler);
      busHandlers.set(event, next);
      return () => {
        const current = busHandlers.get(event) ?? [];
        busHandlers.set(event, current.filter((entry) => entry !== handler));
      };
    },
    emit(event: string, payload: unknown) {
      for (const handler of busHandlers.get(event) ?? []) {
        handler(payload);
      }
    }
  };

  const pi = {
    appendEntry: () => {},
    events,
    getActiveTools: () => Array.from(tools.keys()),
    getAllTools: () => Array.from(tools.entries()).map(([name, definition]) => ({ name, ...(definition as object) })),
    getCommands: () => Array.from(commands.keys()).map((name) => ({ name })),
    getFlag: (name: string) => flags.get(name),
    getSessionName: () => "panda-harness-session",
    getThinkingLevel: () => "standard",
    on(event: string, handler: Handler) {
      const next = lifecycleHandlers.get(event) ?? [];
      next.push(handler);
      lifecycleHandlers.set(event, next);
    },
    registerCommand(name: string, definition: unknown) {
      commands.set(name, definition);
    },
    registerFlag(name: string, definition: unknown) {
      flags.set(name, definition);
    },
    registerMessageRenderer(name: string, definition: unknown) {
      renderers.set(name, definition);
    },
    registerProvider(name: string, definition: unknown) {
      providers.set(name, definition);
    },
    registerShortcut(name: string, definition: unknown) {
      shortcuts.set(String(name), definition);
    },
    registerTool(definition: { name: string }) {
      tools.set(definition.name, definition);
    },
    registerUiWidget(name: string, definition: unknown) {
      widgets.set(name, definition);
    },
    sendMessage: () => {},
    sendUserMessage: () => {},
    setActiveTools: () => {},
    setModel: () => {}
  };

  const proxiedPi = new Proxy(pi, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        return () => {};
      }
      return Reflect.get(target, prop, receiver);
    }
  });

  return {
    commands,
    flags,
    async fireLifecycle(event: string, payload: unknown = {}, ctx: unknown = {}) {
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
    lifecycleHandlers,
    pi: proxiedPi,
    providers,
    renderers,
    shortcuts,
    tools,
    widgets
  };
}
