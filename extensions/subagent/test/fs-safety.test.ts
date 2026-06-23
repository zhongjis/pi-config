import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSymlink, isUnsafeName, safeReadFile } from "../src/fs-safety.js";

describe("fs-safety", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-fs-safety-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("isUnsafeName (whitelist validation)", () => {
    it("rejects empty string", () => {
      expect(isUnsafeName("")).toBe(true);
    });

    it("rejects names longer than 128 chars", () => {
      expect(isUnsafeName("a".repeat(129))).toBe(true);
    });

    it("rejects path traversal", () => {
      expect(isUnsafeName("../../etc")).toBe(true);
    });

    it("rejects names starting with dot", () => {
      expect(isUnsafeName(".hidden")).toBe(true);
    });

    it("rejects names with spaces", () => {
      expect(isUnsafeName("foo bar")).toBe(true);
    });

    it("rejects names with special characters", () => {
      expect(isUnsafeName("foo;bar")).toBe(true);
      expect(isUnsafeName("foo|bar")).toBe(true);
      expect(isUnsafeName("foo`bar")).toBe(true);
    });

    it("allows valid names", () => {
      expect(isUnsafeName("my-agent")).toBe(false);
      expect(isUnsafeName("agent_v2")).toBe(false);
      expect(isUnsafeName("Agent123")).toBe(false);
      expect(isUnsafeName("my-agent.v2")).toBe(false);
    });
  });

  describe("isSymlink", () => {
    it("returns false for regular file", () => {
      const file = join(tmpDir, "regular.txt");
      writeFileSync(file, "content");
      expect(isSymlink(file)).toBe(false);
    });

    it("returns true for symlink", () => {
      const file = join(tmpDir, "real.txt");
      const link = join(tmpDir, "link.txt");
      writeFileSync(file, "content");
      symlinkSync(file, link);
      expect(isSymlink(link)).toBe(true);
    });

    it("returns false for nonexistent path", () => {
      expect(isSymlink(join(tmpDir, "nope"))).toBe(false);
    });
  });

  describe("safeReadFile", () => {
    it("reads regular files", () => {
      const file = join(tmpDir, "regular.txt");
      writeFileSync(file, "hello");
      expect(safeReadFile(file)).toBe("hello");
    });

    it("rejects symlinked files", () => {
      const file = join(tmpDir, "real.txt");
      const link = join(tmpDir, "link.txt");
      writeFileSync(file, "secret");
      symlinkSync(file, link);
      expect(safeReadFile(link)).toBeUndefined();
    });

    it("returns undefined for nonexistent files", () => {
      expect(safeReadFile(join(tmpDir, "nope.txt"))).toBeUndefined();
    });
  });
});
