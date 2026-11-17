export type PaneHost = "herdr-app";

/**
 * Terminal host managing the current pane, from the environment it injects.
 * Callers must resolve its exact HC terminal, never focused context.
 */
export function detectPaneHost(env: NodeJS.ProcessEnv = process.env): PaneHost | undefined {
  if (env.HC_TERMINAL_ID) return "herdr-app";
  return undefined;
}
