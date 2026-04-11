declare const process: {
  env: Record<string, string | undefined>;
};

declare module "@mariozechner/pi-coding-agent" {
  export function getAgentDir(): string;
  export type ExtensionAPI = any;
}

declare module "@mariozechner/pi-tui" {
  export interface ThemeLike {
    fg(color: string, text: string): string;
  }
}

declare module "child_process" {
  export function execSync(command: string, options?: any): string;
}

declare module "fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function unlinkSync(path: string): void;
}

declare module "path" {
  export function join(...parts: string[]): string;
}

declare module "@mariozechner/pi-ai" {
  export type Api = string;
  export type Context = any;
  export type SimpleStreamOptions = Record<string, unknown>;

  const modelType: unique symbol;

  export interface Model<T = unknown> {
    readonly [modelType]?: T;
    id: string;
    provider?: string;
    api?: Api;
    [key: string]: any;
  }

  export interface AssistantMessageEventStream extends AsyncIterable<any> {
    push(event: any): void;
    end(): void;
  }

  export function createAssistantMessageEventStream(): AssistantMessageEventStream;
  export function streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions): AsyncIterable<any>;
  export function streamSimpleAnthropic(model: Model<any>, context: Context, options?: SimpleStreamOptions): AsyncIterable<any>;
}
