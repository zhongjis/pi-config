import { describe, it, expect } from "vitest";
import { parseTarget } from "../src/detect.js";

describe("parseTarget", () => {
  it("returns auto for empty args", () => {
    expect(parseTarget("")).toEqual({ kind: "auto" });
    expect(parseTarget("   ")).toEqual({ kind: "auto" });
  });

  it("returns uncommitted for 'uncommitted'", () => {
    expect(parseTarget("uncommitted")).toEqual({ kind: "uncommitted" });
  });

  it("returns base with no ref when only 'base'", () => {
    expect(parseTarget("base")).toEqual({ kind: "base", ref: undefined });
  });

  it("returns base with ref when 'base main'", () => {
    expect(parseTarget("base main")).toEqual({ kind: "base", ref: "main" });
  });

  it("returns base with ref when 'base origin/develop'", () => {
    expect(parseTarget("base origin/develop")).toEqual({ kind: "base", ref: "origin/develop" });
  });

  it("returns commit with no ref when only 'commit'", () => {
    expect(parseTarget("commit")).toEqual({ kind: "commit", ref: undefined });
  });

  it("returns commit with sha when 'commit abc123'", () => {
    expect(parseTarget("commit abc123")).toEqual({ kind: "commit", ref: "abc123" });
  });

  it("returns auto for unknown subcommand", () => {
    expect(parseTarget("unknown")).toEqual({ kind: "auto" });
    expect(parseTarget("foobar abc")).toEqual({ kind: "auto" });
  });

  it("is case-insensitive for subcommand", () => {
    expect(parseTarget("UNCOMMITTED")).toEqual({ kind: "uncommitted" });
    expect(parseTarget("BASE main")).toEqual({ kind: "base", ref: "main" });
    expect(parseTarget("COMMIT abc")).toEqual({ kind: "commit", ref: "abc" });
  });
});
