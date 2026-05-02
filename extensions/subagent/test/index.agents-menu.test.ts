import { describe, expect, it } from "vitest";
import {
  buildEjectedAgentMarkdown,
  buildGenerateAgentPrompt,
  buildManualAgentMarkdown,
} from "../src/agent-definition-authoring.js";
import type { AgentConfig } from "../src/types.js";

describe("/agents authoring surfaces", () => {
  it("eject output uses builtin_tools and extension_tools without legacy denylist fields", () => {
    const cfg: AgentConfig = {
      name: "reviewer",
      description: "Review code",
      builtinToolNames: ["read", "bash"],
      extensionToolNames: [],
      disallowedTools: ["write"],
      extensions: ["web-search"],
      skills: true,
      systemPrompt: "Review carefully.",
      promptMode: "replace",
    };

    const markdown = buildEjectedAgentMarkdown(cfg);

    expect(markdown).toMatchInlineSnapshot(`
      "---
      description: Review code
      builtin_tools: read, bash
      extension_tools: none
      prompt_mode: replace
      extensions: web-search
      ---

      Review carefully.
      "
    `);
    expect(markdown).not.toContain("\ntools:");
    expect(markdown).not.toContain("disallowed_tools:");
  });

  it("eject output omits extension_tools when the config does not set an exact filter", () => {
    const cfg: AgentConfig = {
      name: "default-ext-tools",
      description: "Uses all extension tools",
      builtinToolNames: ["read"],
      extensions: true,
      skills: true,
      systemPrompt: "Read only.",
      promptMode: "append",
    };

    const markdown = buildEjectedAgentMarkdown(cfg);

    expect(markdown).toContain("builtin_tools: read");
    expect(markdown).not.toContain("extension_tools:");
    expect(markdown).not.toContain("\ntools:");
  });

  it("generate prompt forbids legacy tool fields and templates builtin/extension fields", () => {
    const prompt = buildGenerateAgentPrompt("review TypeScript", "/tmp/reviewer.md");
    const template = prompt.match(/```markdown\n([\s\S]*?)\n```/)?.[1] ?? "";

    expect(template).toContain("builtin_tools:");
    expect(template).toContain("extensions:");
    expect(template).toContain("extension_tools:");
    expect(template).not.toContain("\ntools:");
    expect(template).not.toContain("disallowed_tools:");
    expect(prompt).toContain("Old `tools:` frontmatter is invalid/obsolete");
    expect(prompt).toContain("Old tool denylist fields `disallowed_tools:` and `disallow_tools:` are invalid and obsolete");
  });

  it("manual output writes builtin_tools plus extension scope and exact tool filters", () => {
    const markdown = buildManualAgentMarkdown({
      description: "Manual reviewer",
      builtinTools: "read, bash",
      extensionsLine: "\nextensions: web-search",
      extensionToolsLine: "\nextension_tools: search_web",
      systemPrompt: "Review manually.",
    });

    expect(markdown).toMatchInlineSnapshot(`
      "---
      description: Manual reviewer
      builtin_tools: read, bash
      extensions: web-search
      extension_tools: search_web
      prompt_mode: replace
      ---

      Review manually.
      "
    `);
    expect(markdown).not.toContain("\ntools:");
  });
});
