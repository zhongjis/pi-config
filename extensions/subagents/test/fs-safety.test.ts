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

  describe("safeReadFile", () => {
    it("returns undefined for a symlinked path", () => {
      const file = join(tmpDir, "real.txt");
      const link = join(tmpDir, "link.txt");
      writeFileSync(file, "secret");
      symlinkSync(file, link);
      expect(safeReadFile(link)).toBeUndefined();
    });

    it("reads a regular file", () => {
      const file = join(tmpDir, "regular.txt");
      writeFileSync(file, "hello");
      expect(safeReadFile(file)).toBe("hello");
    });

    it("returns undefined for a nonexistent file", () => {
      expect(safeReadFile(join(tmpDir, "nope.txt"))).toBeUndefined();
    });
  });

  describe("isUnsafeName", () => {
    it("returns true for path traversal", () => {
      expect(isUnsafeName("../x")).toBe(true);
    });

    it("returns true for a name starting with a dot", () => {
      expect(isUnsafeName(".hidden")).toBe(true);
    });

    it("returns true for a name longer than 128 chars", () => {
      expect(isUnsafeName("a".repeat(129))).toBe(true);
    });

    it("returns false for a valid name", () => {
      expect(isUnsafeName("good-name")).toBe(false);
    });
  });

  describe("isSymlink", () => {
    it("returns true for a symlink", () => {
      const file = join(tmpDir, "real.txt");
      const link = join(tmpDir, "link.txt");
      writeFileSync(file, "content");
      symlinkSync(file, link);
      expect(isSymlink(link)).toBe(true);
    });

    it("returns false for a regular file", () => {
      const file = join(tmpDir, "regular.txt");
      writeFileSync(file, "content");
      expect(isSymlink(file)).toBe(false);
    });
  });
});
