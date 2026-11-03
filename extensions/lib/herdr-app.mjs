/** Plain-Node boundary shared by extensions and the standalone graph viewer. */
export function parseHerdrAppPanes(stdout) {
  let layout;
  try {
    layout = JSON.parse(stdout);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!layout || !Array.isArray(layout.spaces)) return undefined;
  const panes = [];
  for (const space of layout.spaces) {
    if (!space || !Array.isArray(space.tabs)) return undefined;
    for (const tab of space.tabs) {
      if (!tab || typeof tab.id !== "string" || !tab.id || typeof tab.name !== "string" || !Array.isArray(tab.terminals)) return undefined;
      for (const terminal of tab.terminals) {
        if (!terminal || typeof terminal.terminal !== "string" || !terminal.terminal || typeof terminal.pane !== "string" || !terminal.pane) return undefined;
        panes.push({ terminalId: terminal.terminal, paneId: terminal.pane, tabId: tab.id, tabName: tab.name });
      }
    }
  }
  return panes;
}

export async function readHerdrAppPanes(exec) {
  const result = await exec("herdr-app", ["ls"], { timeout: 3000 });
  return result.code === 0 ? parseHerdrAppPanes(result.stdout) : undefined;
}

export async function resolveHerdrAppTerminal(exec, terminalId) {
  const matches = (await readHerdrAppPanes(exec))?.filter(pane => pane.terminalId === terminalId);
  return matches?.length === 1 ? matches[0] : undefined;
}

export function parseHerdrAppSplit(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return result && typeof result.pane === "string" && result.pane && typeof result.terminal === "string" && result.terminal
    ? { paneId: result.pane, terminalId: result.terminal } : undefined;
}

/** Positional shell arguments keep cwd and program arguments out of shell source. */
export function herdrAppArgv(cwd, argv) {
  return ["sh", "-c", 'cd -- "$1" && shift && exec "$@"', "pi-pane", cwd, ...argv];
}

export const GRAPH_OWNER_LABEL = "pi.graph-owner";

export async function isHerdrAppPaneOwned(exec, paneId, sentinel) {
  const matches = (await readHerdrAppPanes(exec))?.filter(pane => pane.paneId === paneId);
  if (matches?.length !== 1) return false;
  const terminalId = matches[0].terminalId;
  const result = await exec("hc", ["get", terminalId, "--json"], { timeout: 3000 });
  if (result.code !== 0) return false;
  try {
    const terminal = JSON.parse(result.stdout);
    return terminal?.address === terminalId && terminal.state === "live" && terminal.labels?.[GRAPH_OWNER_LABEL] === sentinel;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}
