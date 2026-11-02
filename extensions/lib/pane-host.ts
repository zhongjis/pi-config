export type PaneHost = "herdr" | "orca";

/**
 * Terminal host managing the current pane, from the environment it injects.
 * Herdr wins when both are present: Herdr panes started inside Orca inherit stale `ORCA_*` variables.
 */
export function detectPaneHost(env: NodeJS.ProcessEnv = process.env): PaneHost | undefined {
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) return "herdr";
  if (env.ORCA_TERMINAL_HANDLE) return "orca";
  return undefined;
}
