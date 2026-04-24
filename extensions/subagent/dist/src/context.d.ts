/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
/** Extract text from a message content block array. */
export declare function extractText(content: unknown[]): string;
/**
 * Build a text representation of the parent conversation context.
 * Used when inherit_context is true to give the subagent visibility
 * into what has been discussed/done so far.
 */
export declare function buildParentContext(ctx: ExtensionContext): string;
