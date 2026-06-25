import { describe, expect, it } from "vitest";
import { extensionCanonicalName, buildExtensionsOverride } from "../src/agent-runner.js";

describe("extensionCanonicalName", () => {
  it("directory extension → parent dir name, lowercased", () => {
    expect(extensionCanonicalName("/path/to/readonly-bash/index.ts")).toBe("readonly-bash");
    expect(extensionCanonicalName("/path/to/Clauderock/index.js")).toBe("clauderock");
  });
  it("single-file extension → basename minus ext, lowercased", () => {
    expect(extensionCanonicalName("/path/my-ext.ts")).toBe("my-ext");
  });
});

describe("buildExtensionsOverride", () => {
  const fakeExts = (names: string[]) => ({
    extensions: names.map((n) => ({ path: `/ext/${n}/index.ts` })),
    errors: [],
    runtime: {} as any,
  });

  it("returns undefined when loadAll and no excludes (fast path)", () => {
    expect(buildExtensionsOverride({ extensions: true, excludeExtensions: undefined, isolated: false })).toBeUndefined();
  });

  it("filters to allowlist when extensions is string[]", () => {
    const override = buildExtensionsOverride({ extensions: ["foo", "bar"], excludeExtensions: undefined, isolated: false });
    expect(override).toBeDefined();
    const result = override!(fakeExts(["foo", "bar", "baz"]) as any);
    expect(result.extensions.map((e: any) => extensionCanonicalName(e.path))).toEqual(["foo", "bar"]);
  });

  it("applies exclude after allow (exclude wins)", () => {
    const override = buildExtensionsOverride({ extensions: true, excludeExtensions: ["bar"], isolated: false });
    expect(override).toBeDefined();
    const result = override!(fakeExts(["foo", "bar", "baz"]) as any);
    expect(result.extensions.map((e: any) => extensionCanonicalName(e.path))).toEqual(["foo", "baz"]);
  });

  it("exclude wins over explicit allow", () => {
    const override = buildExtensionsOverride({ extensions: ["foo", "bar"], excludeExtensions: ["bar"], isolated: false });
    const result = override!(fakeExts(["foo", "bar", "baz"]) as any);
    expect(result.extensions.map((e: any) => extensionCanonicalName(e.path))).toEqual(["foo"]);
  });

  it("returns undefined when isolated (nullifies excludes)", () => {
    expect(buildExtensionsOverride({ extensions: true, excludeExtensions: ["bar"], isolated: true })).toBeUndefined();
  });

  it("returns undefined when extensions is false (nothing loads)", () => {
    expect(buildExtensionsOverride({ extensions: false, excludeExtensions: ["bar"], isolated: false })).toBeUndefined();
  });
});
