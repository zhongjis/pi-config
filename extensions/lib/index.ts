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
/**
 * No-op extension entry point.
 * Pi discovers lib/index.ts as a potential extension; this default export
 * satisfies the factory function check without registering anything.
 * Extensions that use the library call initLib(pi) explicitly.
 */
export default function _libNoop(_pi: ExtensionAPI): void {}

