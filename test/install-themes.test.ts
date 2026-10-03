import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
let tempRoot: string;
let repo: string;
let home: string;
let themes: string;
let source: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-install-themes-"));
  repo = join(tempRoot, "repo");
  home = join(tempRoot, "home");
  themes = join(home, ".pi", "agent", "themes");
  source = join(repo, "themes", "github-diff.json");
  await mkdir(join(repo, "themes"), { recursive: true });
  await mkdir(join(repo, "extensions"));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await copyFile(resolve(import.meta.dirname, "../install.sh"), join(repo, "install.sh"));
  await writeFile(source, "{}\n");
  await writeFile(join(repo, "themes", "AGENTS.md"), "Theme documentation\n");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function install() {
  // The isolated repo has no workspace or git packages, so no dependency installs run.
  return execFileAsync("bash", [join(repo, "install.sh")], {
    env: { ...process.env, HOME: home },
  });
}

describe("installer theme ownership", () => {
  it("migrates only the directory link, preserves its target, and repeats safely", async () => {
    await symlink(join(repo, "themes"), themes);
    const before = await readFile(source);

    await install();
    await install();

    expect((await lstat(themes)).isSymbolicLink()).toBe(false);
    expect((await lstat(themes)).isDirectory()).toBe(true);
    expect(await readlink(join(themes, "github-diff.json"))).toBe(source);
    expect(await readFile(source)).toEqual(before);
    expect(await readdir(join(repo, "themes"))).toEqual(["AGENTS.md", "github-diff.json"]);
    expect(await readdir(themes)).toEqual(["github-diff.json"]);
  });

  it("creates an absent themes directory and links only JSON assets", async () => {
    await install();

    expect((await lstat(themes)).isDirectory()).toBe(true);
    expect(await readdir(themes)).toEqual(["github-diff.json"]);
    expect(await readlink(join(themes, "github-diff.json"))).toBe(source);
  });

  it("preserves the real directory, HM Stylix link, and unrelated entries", async () => {
    await mkdir(themes);
    const directoryBefore = await lstat(themes);
    const hmSource = join(tempRoot, "stylix.json");
    await writeFile(hmSource, "HM-owned\n");
    await symlink(hmSource, join(themes, "stylix.json"));
    await writeFile(join(themes, "local.json"), "local\n");
    await symlink(join(tempRoot, "missing"), join(themes, "unrelated.json"));

    await install();
    await install();

    expect((await lstat(themes)).ino).toBe(directoryBefore.ino);
    expect(await readlink(join(themes, "stylix.json"))).toBe(hmSource);
    expect(await readFile(hmSource, "utf8")).toBe("HM-owned\n");
    expect(await readFile(join(themes, "local.json"), "utf8")).toBe("local\n");
    expect(await readlink(join(themes, "unrelated.json"))).toBe(join(tempRoot, "missing"));
    expect(await readlink(join(themes, "github-diff.json"))).toBe(source);
  });

  it.each(["file", "directory", "symlink", "dangling symlink"])("refuses a conflicting theme %s", async (kind) => {
    await mkdir(themes);
    const destination = join(themes, "github-diff.json");
    const other = join(tempRoot, "other.json");
    if (kind === "file") await writeFile(destination, "user-owned\n");
    else if (kind === "directory") await mkdir(destination);
    else {
      if (kind === "symlink") await writeFile(other, "other\n");
      await symlink(other, destination);
    }
    const before = await lstat(destination);

    await expect(install()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("conflicting theme destination") });

    expect((await lstat(destination)).ino).toBe(before.ino);
    if (kind === "file") expect(await readFile(destination, "utf8")).toBe("user-owned\n");
    if (kind.includes("symlink")) expect(await readlink(destination)).toBe(other);
    expect(await readFile(source, "utf8")).toBe("{}\n");
  });

  it.each(["existing", "dangling"])("refuses an unknown %s directory link, including one into the repo", async (kind) => {
    const other = join(repo, "other-themes");
    if (kind === "existing") {
      await mkdir(other);
      await writeFile(join(other, "keep.json"), "untouched\n");
    }
    await symlink(other, themes);

    await expect(install()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("unknown themes symlink") });

    expect(await readlink(themes)).toBe(other);
    if (kind === "existing") expect(await readFile(join(other, "keep.json"), "utf8")).toBe("untouched\n");
  });

  it("refuses a non-directory themes destination", async () => {
    await writeFile(themes, "user-owned\n");

    await expect(install()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("non-directory themes destination") });

    expect(await readFile(themes, "utf8")).toBe("user-owned\n");
  });
});
