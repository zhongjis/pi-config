export type HerdrAppExec = (command: string, args: string[], options?: { timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;
export type HerdrAppPane = { readonly terminalId: string; readonly paneId: string; readonly tabId: string; readonly tabName: string; readonly app?: string };
export function parseHerdrAppPanes(stdout: string): HerdrAppPane[] | undefined;
export function readHerdrAppPanes(exec: HerdrAppExec): Promise<HerdrAppPane[] | undefined>;
export function resolveHerdrAppTerminal(exec: HerdrAppExec, terminalId: string): Promise<HerdrAppPane | undefined>;
export function parseHerdrAppSplit(stdout: string): { readonly paneId: string; readonly terminalId: string } | undefined;
export function herdrAppArgv(cwd: string, argv: readonly string[]): string[];
export const GRAPH_OWNER_LABEL: "pi.graph-owner";
export function isHerdrAppPaneOwned(exec: HerdrAppExec, paneId: string, sentinel: string): Promise<boolean>;
