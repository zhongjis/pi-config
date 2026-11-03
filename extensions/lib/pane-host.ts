export type PaneHost = "herdr-app" | "herdr" | "orca";

/**
 * Terminal host managing the current pane, from the environment it injects.
 * HC wins over inherited native Herdr/Orca variables; app callers must resolve its exact terminal, never focused context.
 */
export function detectPaneHost(env: NodeJS.ProcessEnv = process.env): PaneHost | undefined {
  if (env.HC_TERMINAL_ID) return "herdr-app";
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) return "herdr";
  if (env.ORCA_TERMINAL_HANDLE) return "orca";
  return undefined;
}
