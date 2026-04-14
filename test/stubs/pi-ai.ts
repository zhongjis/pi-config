export type Api = any;
export type AssistantMessage = any;
export type Message = any;
export type Model = {
  provider?: string;
  id?: string;
};

export async function complete(): Promise<{ stopReason: string; content: Array<{ type: string; text: string }> }> {
  return {
    stopReason: "stop",
    content: [{ type: "text", text: "" }]
  };
}

export function getModel(provider: string, id: string) {
  return { provider, id };
}

export function StringEnum(values: string[], options: Record<string, unknown> = {}) {
  return {
    enum: values,
    ...options
  };
}

export function createAssistantMessageEventStream() {
  return {
    on() {},
    async *[Symbol.asyncIterator]() {}
  };
}

export async function streamSimple() {
  return {
    content: [],
    text: ""
  };
}

export async function streamSimpleAnthropic() {
  return {
    content: [],
    text: ""
  };
}
