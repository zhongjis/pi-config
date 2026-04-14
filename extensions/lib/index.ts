import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  applyDebugFlag,
  initDebugFromEnv,
  registerDebugCommand,
  registerDebugFlag,
} from "./logger.js";

export * from "./clipboard.js";
export * from "./logger.js";
export * from "./status.js";
export * from "./utils.js";
export * from "./ux.js";

/**
 * Wire the shared library into an extension.
 * Safe to call from multiple extensions — all registrations are idempotent.
 *
 * Call once at the top of each extension's registration function:
 *
 * ```ts
 * export default function myExtension(pi: ExtensionAPI) {
 *   initLib(pi);
 *   // ...
 * }
 * ```
 */
export function initLib(pi: ExtensionAPI): void {
  initDebugFromEnv();
  registerDebugFlag(pi);
  applyDebugFlag(pi);
  registerDebugCommand(pi);
}
