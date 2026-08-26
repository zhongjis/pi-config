import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeActiveToolNames, DEFAULT_BUILTIN_TOOL_NAMES } from "../../lib/active-tools.js";
import { parseModeAgentConfig } from "../src/config-loader.js";
import type { Mode } from "../src/types.js";

// Regression: goal-mode continuation requires the goal tools to be callable by
// modes that own goal-mode continuation. Hou Tu/Atlas-aligned plan execution
// intentionally does not expose them.
const GOAL_TOOL_MODES: Mode[] = ["kuafu", "fuxi", "luban", "shennong", "zhurong"];
const NON_GOAL_TOOL_MODES: Mode[] = ["houtu"];
const GOAL_TOOLS = ["create_goal", "get_goal", "update_goal"];

describe("mode frontmatter exposes goal tools", () => {
  for (const mode of GOAL_TOOL_MODES) {
    it(`${mode} allows the goal tools through the extension-tool filter`, () => {
      const content = readFileSync(join(process.cwd(), "modes", mode, "mode.md"), "utf-8");
      const config = parseModeAgentConfig(content);
      expect(config).not.toBeNull();
      const selection = config?.extensionToolNames;
      expect(selection, `${mode} declares an extension_tools allowlist`).toBeDefined();

      for (const tool of GOAL_TOOLS) {
        expect(selection, `${mode} extension_tools lists ${tool}`).toContain(tool);
      }

      const active = computeActiveToolNames({
        availableToolNames: [...GOAL_TOOLS, "ask"],
        builtinToolNames: [...DEFAULT_BUILTIN_TOOL_NAMES],
        builtinToolUniverse: [...DEFAULT_BUILTIN_TOOL_NAMES],
        extensions: true,
        extensionTools: selection,
      });

      for (const tool of GOAL_TOOLS) {
        expect(active, `${mode} exposes ${tool} to the agent`).toContain(tool);
      }
    });
  }

  for (const mode of NON_GOAL_TOOL_MODES) {
    it(`${mode} keeps goal tools out of the extension-tool filter`, () => {
      const content = readFileSync(join(process.cwd(), "modes", mode, "mode.md"), "utf-8");
      const config = parseModeAgentConfig(content);
      expect(config).not.toBeNull();
      const selection = config?.extensionToolNames;
      expect(selection, `${mode} declares an extension_tools allowlist`).toBeDefined();

      for (const tool of GOAL_TOOLS) {
        expect(selection, `${mode} extension_tools omits ${tool}`).not.toContain(tool);
      }

      const active = computeActiveToolNames({
        availableToolNames: [...GOAL_TOOLS, "ask"],
        builtinToolNames: [...DEFAULT_BUILTIN_TOOL_NAMES],
        builtinToolUniverse: [...DEFAULT_BUILTIN_TOOL_NAMES],
        extensions: true,
        extensionTools: selection,
      });

      for (const tool of GOAL_TOOLS) {
        expect(active, `${mode} does not expose ${tool} to the agent`).not.toContain(tool);
      }
    });
  }
});
