import { GRAPH_OWNER_LABEL, herdrAppArgv, parseHerdrAppSplit } from "../../../../lib/herdr-app.mjs";
import type { GraphRunPaneControllerOptions } from "./controller.js";
import { writeRecord } from "./store.js";

/** Ambiguous launches and unlabelled panes stay suppressed until an explicit reopen. */
export async function splitHerdrAppPane(options: GraphRunPaneControllerOptions, sentinel: string): Promise<void> {
  const { exec, dir, parentPaneId } = options;
  const timeout = options.timeoutMs ?? 10_000;
  writeRecord(dir, { paneId: "", sentinel, closedByUser: true });
  const argv = herdrAppArgv(options.cwd, ["node", options.viewerPath, "--dir", dir, "--ppid", String(options.ppid), "--host", "herdr-app"]);
  const result = await exec("herdr-app", ["do", "pane.split", "--pane", parentPaneId, "--direction", "right", "--argv", JSON.stringify(argv)], { timeout });
  if (result.code !== 0 || result.killed) return;
  await exec("herdr-app", ["do", "pane.focus", "--pane", parentPaneId], { timeout });
  const split = parseHerdrAppSplit(result.stdout);
  if (!split) return;
  writeRecord(dir, { paneId: split.paneId, sentinel, closedByUser: true });
  const labelled = await exec("hc", ["label", split.terminalId, `${GRAPH_OWNER_LABEL}=${sentinel}`, "--json"], { timeout });
  if (labelled.code === 0 && !labelled.killed) writeRecord(dir, { paneId: split.paneId, sentinel, closedByUser: false });
}
